import { requestUrl } from "obsidian";

export type Value = string | number | boolean;
export type Properties = { [key: string]: Array<Value> };

export interface SearchResponse {
	search: Entity[];
	success: number;
}

export interface GetPropertiesOptions {
	language: string;
	ignoreCategories: boolean;
	ignoreWikipediaPages: boolean;
	ignoreIDs: boolean;
	ignorePropertiesWithTimeRanges: boolean;
	internalLinkPrefix: string;
	spaceReplacement: string;
}

export interface SearchOptions {
	language: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Wikidata Blazegraph endpoint. Post graph-split it no longer serves scholarly
 *  articles (instance of Q13442814 and related types). */
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/** QLever Wikidata mirror — full graph, including the scholarly-article split.
 *  Does NOT support the wikibase:label SERVICE; uses rdfs:label instead.
 *  Does NOT accept &format=json; format is negotiated via Accept header only. */
const QLEVER_SPARQL = "https://qlever.cs.uni-freiburg.de/api/wikidata";

// ---------------------------------------------------------------------------
// Prefixes
// ---------------------------------------------------------------------------

/** Standard Wikidata SPARQL prefixes. Blazegraph injects these automatically;
 *  QLever requires them to be declared explicitly. */
const WIKIDATA_PREFIXES = `\
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX psn: <http://www.wikidata.org/prop/statement/value-normalized/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX pqn: <http://www.wikidata.org/prop/qualifier/value-normalized/>
PREFIX pr: <http://www.wikidata.org/prop/reference/>
PREFIX prn: <http://www.wikidata.org/prop/reference/value-normalized/>
PREFIX wdref: <http://www.wikidata.org/reference/>
PREFIX wdv: <http://www.wikidata.org/value/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX bd: <http://www.bigdata.com/rdf#>
`;

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

/**
 * Parse the user-supplied language setting (e.g. "mul,en", "de", "zh,en") into
 * an ordered list of real BCP-47 language tags, dropping the Wikidata-internal
 * pseudo-code "mul" which is not valid inside SPARQL FILTER(LANG(…)) or the
 * wikibase:label SERVICE.
 *
 * "en" is appended as a final fallback if not already present, so labels are
 * never silently dropped when the preferred language is unavailable.
 */
function parseLangs(language: string): string[] {
	const langs = language
		.split(",")
		.map((l) => l.trim().toLowerCase())
		.filter((l) => l.length > 0 && l !== "mul");

	if (!langs.includes("en")) langs.push("en");
	return langs;
}

/**
 * Build a SPARQL FILTER expression that accepts any of the given language tags.
 *   FILTER(LANG(?x) = "de" || LANG(?x) = "en")
 */
function langFilter(variable: string, langs: string[]): string {
	return langs.map((l) => `LANG(${variable}) = "${l}"`).join(" || ");
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function isString(type: string | null): boolean {
	if (!type) return false;
	return (
		type === "http://www.w3.org/2001/XMLSchema#string" ||
		type === "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
	);
}

function isInteger(type: string | null): boolean {
	if (!type) return false;
	return type === "http://www.w3.org/2001/XMLSchema#integer";
}

function isDecimal(type: string | null): boolean {
	if (!type) return false;
	return type === "http://www.w3.org/2001/XMLSchema#decimal";
}

function isDate(type: string | null): boolean {
	if (!type) return false;
	return type === "http://www.w3.org/2001/XMLSchema#dateTime";
}

// ---------------------------------------------------------------------------
// SPARQL runner
// ---------------------------------------------------------------------------

/**
 * Execute a SPARQL SELECT query and return the raw result bindings.
 *
 * @param endpoint  Full base URL of the SPARQL endpoint.
 * @param query     Complete SPARQL query string (including PREFIX declarations
 *                  when targeting QLever).
 * @param qlever    When true, omits the Blazegraph-specific `&format=json`
 *                  query parameter; format is negotiated via Accept header only.
 */
async function runSparql(
	endpoint: string,
	query: string,
	qlever = false,
): Promise<any[]> {
	const url = qlever
		? `${endpoint}?query=${encodeURIComponent(query)}`
		: `${endpoint}?query=${encodeURIComponent(query)}&format=json`;

	try {
		const response = await requestUrl({
			url,
			headers: { Accept: "application/sparql-results+json" },
		});
		return response.json?.results?.bindings ?? [];
	} catch (e) {
		console.warn(`[wikidata-importer] SPARQL query failed (${endpoint}):`, e);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export class Entity {
	id: string;
	label?: string;
	description?: string;

	constructor(id: string, label?: string, description?: string) {
		this.id = id;
		this.label = label;
		this.description = description;
	}

	static fromJson(json: any): Entity {
		if (!json.id || typeof json.id !== "string") {
			throw new Error("Invalid entity ID");
		}
		if (!json.label || typeof json.label !== "string") {
			throw new Error("Invalid entity label");
		}
		if (!json.description || typeof json.description !== "string") {
			throw new Error("Invalid entity description");
		}
		return new Entity(json.id, json.label, json.description);
	}

	static fromId(id: string): Entity {
		return new Entity(id);
	}

	static async search(query: string, opts: SearchOptions): Promise<Entity[]> {
		if (!query || query.length === 0) return [];

		// Support comma-separated language list, including "mul" which the
		// Wikidata action API does accept (unlike SPARQL FILTER).
		const languages = opts.language
			.split(",")
			.map((l) => l.trim().toLowerCase())
			.filter(Boolean);

		const allResults = new Map<string, Entity>();

		for (const lang of languages) {
			const url =
				`https://www.wikidata.org/w/api.php` +
				`?action=wbsearchentities&format=json` +
				`&language=${lang}&uselang=${lang}` +
				`&type=item&limit=10` +
				`&search=${encodeURIComponent(query)}`;
			try {
				const response = await requestUrl(url);
				const json: SearchResponse = response.json;
				for (const result of json.search) {
					if (!allResults.has(result.id)) {
						allResults.set(result.id, Entity.fromJson(result));
					}
				}
			} catch (e) {
				console.warn(
					`[wikidata-importer] Search failed for language "${lang}":`,
					e,
				);
			}
		}

		return Array.from(allResults.values());
	}

	static replaceCharacters(
		str: string,
		searchString: string,
		replaceString: string,
	): string {
		let result = str;
		for (let i = 0; i < searchString.length; i++) {
			const searchChar = searchString[i];
			const replaceChar =
				replaceString[Math.min(i, replaceString.length - 1)];
			result = result.replace(
				new RegExp(`\\${searchChar}`, "g"),
				replaceChar,
			);
		}
		return result;
	}

	static buildLink(link: string, label: string, id: string): string {
		const sanitisedLabel = Entity.replaceCharacters(
			label,
			'*/:#?<>[]"',
			"_",
		);
		return link
			.replace(/\$\{label\}/g, sanitisedLabel)
			.replace(/\$\{id\}/g, id);
	}

	// -------------------------------------------------------------------------
	// Query builders
	// -------------------------------------------------------------------------

	/**
	 * Build the shared body of the properties SPARQL query.
	 *
	 * Two label strategies are supported:
	 *
	 * - Blazegraph (`useRdfsLabel = false`): uses the wikibase:label SERVICE
	 *   which resolves labels server-side and handles language fallback
	 *   automatically.
	 *
	 * - QLever (`useRdfsLabel = true`): the wikibase:label SERVICE is not
	 *   supported, so labels are fetched via rdfs:label with an explicit
	 *   FILTER over the user's preferred languages plus "en" as a fallback.
	 *   "mul" is excluded because it is not a valid BCP-47 tag in FILTER(LANG()).
	 */
	private buildPropertiesQuery(
		opts: GetPropertiesOptions,
		useRdfsLabel: boolean,
	): string {
		const langs = parseLangs(opts.language);
		// For the description OPTIONAL we use the first real language only
		// (FILTER supports only one tag here in both endpoints).
		const primaryLang = langs[0];

		const labelFragment = useRdfsLabel
			? `
				OPTIONAL {
					?property rdfs:label ?propertyLabel .
					FILTER(${langFilter("?propertyLabel", langs)})
				}
				OPTIONAL {
					?value rdfs:label ?valueLabel .
					FILTER(${langFilter("?valueLabel", langs)})
				}`
			: `
				SERVICE wikibase:label {
					bd:serviceParam wikibase:language "${langs.join(",")}" .
				}`;

		let query = `
			SELECT ?propertyLabel ?value ?valueLabel ?valueType ?normalizedValue ?description WHERE {
				wd:${this.id} ?propUrl ?value .
				?property wikibase:directClaim ?propUrl .
				OPTIONAL {
					wd:${this.id} schema:description ?description .
					FILTER(LANG(?description) = "${primaryLang}")
				}
				OPTIONAL {
					?statement psn:P31 ?normalizedValue .
					?normalizedValue wikibase:quantityUnit ?unit .
				}
				BIND(DATATYPE(?value) AS ?valueType) .
		`;

		if (opts.ignorePropertiesWithTimeRanges) {
			query += `
				MINUS { ?value p:P580 ?startDateStatement. }
				MINUS { ?value p:P582 ?endDateStatement. }
				MINUS { ?value p:P585 ?pointInTimeStatement. }
			`;
		}

		query += labelFragment + "\n\t\t}";
		return query;
	}

	// -------------------------------------------------------------------------
	// Binding parser
	// -------------------------------------------------------------------------

	/**
	 * Translate raw SPARQL result bindings into the Properties map, merging
	 * into `ret`. Values that already exist (from a previous endpoint) are
	 * deduplicated by string representation so that running both Blazegraph and
	 * QLever never produces duplicate frontmatter entries.
	 */
	private parseBindings(
		results: any[],
		opts: GetPropertiesOptions,
		ret: Properties,
	): void {
		for (const r of results) {
			let key: string = r.propertyLabel?.value;
			if (!key) continue;

			const value: string = r.value?.value;
			if (!value) continue;

			const normalizedValue: string | null =
				r.normalizedValue?.value ?? null;
			const type: string | null = r.valueType?.value ?? null;
			const valueLabel: string | null = r.valueLabel?.value ?? null;

			if (
				opts.ignoreCategories &&
				valueLabel?.startsWith("Category:")
			) {
				continue;
			}

			if (
				opts.ignoreWikipediaPages &&
				valueLabel?.startsWith("Wikipedia:")
			) {
				continue;
			}

			if (opts.ignoreIDs && key.match(/\bID\b/)) {
				continue;
			}

			if (opts.spaceReplacement) {
				key = key.replace(/[^\d\p{L}]+/gu, opts.spaceReplacement);
			}

			let toAdd: Value | null = valueLabel;

			if (normalizedValue) {
				toAdd = normalizedValue;
			} else if (isDate(type)) {
				toAdd = value;
			} else if (isDecimal(type)) {
				toAdd = Number.parseFloat(value);
			} else if (isInteger(type)) {
				toAdd = Number.parseInt(value);
			} else if (isString(type)) {
				toAdd = value;
			} else if (value.match(/Q\d+$/) && valueLabel) {
				const idMatch = value.match(/(\d+)$/);
				if (!idMatch) continue;
				const label = Entity.buildLink(
					opts.internalLinkPrefix,
					valueLabel,
					idMatch[1],
				);
				toAdd = `[[${label}]]`;
			}

			if (toAdd === null) continue;

			if (ret[key]) {
				const strVal = String(toAdd);
				if (!ret[key].some((v) => String(v) === strVal)) {
					ret[key].push(toAdd);
				}
			} else {
				ret[key] = [toAdd];
			}
		}
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Fetch all properties for this entity by querying both endpoints and
	 * merging the results.
	 *
	 * - Blazegraph (`query.wikidata.org`) is queried first; it is the
	 *   authoritative source for non-scholarly entities.
	 * - QLever is queried second and fills in statements that are missing from
	 *   Blazegraph due to the scholarly-article graph split. Results are merged
	 *   and deduplicated.
	 */
	async getProperties(opts: GetPropertiesOptions): Promise<Properties> {
		const ret: Properties = {};

		const [wdResults, qlResults] = await Promise.all([
			runSparql(
				WIKIDATA_SPARQL,
				this.buildPropertiesQuery(opts, false),
			),
			runSparql(
				QLEVER_SPARQL,
				WIKIDATA_PREFIXES + this.buildPropertiesQuery(opts, true),
				true,
			),
		]);

		this.parseBindings(wdResults, opts, ret);
		this.parseBindings(qlResults, opts, ret);

		return ret;
	}
}
