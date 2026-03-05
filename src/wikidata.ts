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

/** Wikidata Blazegraph endpoint. Following the graph split it no longer
 *  serves scholarly articles (instance of Q13442814 and related types).
 *  @see https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split */
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/** QLever Wikidata mirror — full graph, including the scholarly-article split.
 *  Differences from Blazegraph:
 *  - Does NOT support the wikibase:label SERVICE; labels fetched via rdfs:label.
 *  - Does NOT accept &format=json; format negotiated via Accept header only.
 *  - Requires explicit PREFIX declarations (Blazegraph injects them implicitly). */
const QLEVER_SPARQL = "https://qlever.cs.uni-freiburg.de/api/wikidata";

// ---------------------------------------------------------------------------
// Prefixes (QLever only — Blazegraph injects these automatically)
// ---------------------------------------------------------------------------

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
 * Parse the user-supplied language setting into an ordered list of real BCP-47
 * language tags.
 *
 * "mul" is a Wikidata-internal pseudo-code meaning "multiple languages". It is
 * accepted by the Wikidata action API but is NOT a valid BCP-47 tag and will
 * silently match nothing inside a SPARQL FILTER(LANG(...)) expression or the
 * wikibase:label SERVICE. It is therefore stripped here.
 *
 * "en" is appended as a final fallback when not already present, ensuring
 * labels are never silently dropped when the preferred language is unavailable.
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
 * Build a SPARQL FILTER clause that accepts any of the given language tags:
 *   FILTER(LANG(?x) = "de" || LANG(?x) = "en")
 */
function langFilter(variable: string, langs: string[]): string {
	return langs.map((l) => `LANG(${variable}) = "${l}"`).join(" || ");
}

// ---------------------------------------------------------------------------
// XSD type helpers
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
 * @param query     Complete SPARQL query string. Must include PREFIX declarations
 *                  when targeting QLever (Blazegraph injects them automatically).
 * @param qlever    When true, omits the Blazegraph-specific `&format=json`
 *                  parameter; the response format is negotiated via Accept header.
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

	/**
	 * Construct an Entity from a raw Wikidata API search result.
	 * `label` and `description` are optional: stub items and newly created
	 * entities may legitimately lack one or both fields.
	 */
	static fromJson(json: any): Entity {
		if (!json.id || typeof json.id !== "string") {
			throw new Error("Invalid entity: missing id");
		}
		return new Entity(
			json.id,
			typeof json.label === "string" ? json.label : undefined,
			typeof json.description === "string" ? json.description : undefined,
		);
	}

	static fromId(id: string): Entity {
		return new Entity(id);
	}

	/**
	 * Search Wikidata for entities matching `query`.
	 *
	 * The language setting may be a comma-separated list (e.g. "mul,en").
	 * "mul" is kept here because the Wikidata action API accepts it and uses it
	 * to return labels in whatever language is available — unlike SPARQL queries
	 * where "mul" must be stripped (see parseLangs).
	 */
	static async search(query: string, opts: SearchOptions): Promise<Entity[]> {
		if (!query || query.length === 0) return [];

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
	// Query builder
	// -------------------------------------------------------------------------

	/**
	 * Build the SPARQL SELECT query for fetching all properties of this entity.
	 *
	 * Two label strategies are supported depending on the target endpoint:
	 *
	 * **Blazegraph** (`useRdfsLabel = false`): uses the proprietary
	 * `wikibase:label SERVICE` which resolves labels server-side with built-in
	 * language fallback.
	 *
	 * **QLever** (`useRdfsLabel = true`): the `wikibase:label SERVICE` is not
	 * supported, so property and value labels are fetched via `rdfs:label` with
	 * explicit language filters. The primary language is preferred over the
	 * fallback via filter ordering.
	 */
	private buildPropertiesQuery(
		opts: GetPropertiesOptions,
		useRdfsLabel: boolean,
	): string {
		const langs = parseLangs(opts.language);
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
	 * Translate raw SPARQL result bindings into the Properties map, merging into
	 * `ret`. Values already present from a prior endpoint are deduplicated by
	 * string representation, so querying both Blazegraph and QLever never
	 * produces duplicate frontmatter entries.
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

			if (opts.ignoreCategories && valueLabel?.startsWith("Category:")) {
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
			} else {
				// Entity-valued property: value URL ends in /Q<digits>
				const entityMatch = value.match(/\/(Q(\d+))$/);
				if (entityMatch && valueLabel) {
					const label = Entity.buildLink(
						opts.internalLinkPrefix,
						valueLabel,
						entityMatch[2], // numeric part only, matching original behaviour
					);
					toAdd = `[[${label}]]`;
				}
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
	 * Fetch all properties for this entity and return them as a key->values map.
	 *
	 * Both SPARQL endpoints are queried in parallel and their results merged:
	 *
	 * - **Blazegraph** (`query.wikidata.org`) — authoritative for the majority
	 *   of Wikidata entities.
	 * - **QLever** (`qlever.cs.uni-freiburg.de`) — full Wikidata graph mirror,
	 *   required for scholarly articles which were moved out of the Blazegraph.
	 *   @see https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split
	 *
	 * Duplicate property values across both responses are deduplicated before
	 * the result is returned.
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
