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

// Wikidata SPARQL endpoint (main graph — excludes scholarly articles post-split)
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

// QLever endpoint for Wikidata — full graph including scholarly articles
// See: https://qlever.cs.uni-freiburg.de/wikidata
const QLEVER_SPARQL = "https://qlever.cs.uni-freiburg.de/api/wikidata";

// Standard Wikidata prefixes that query.wikidata.org injects automatically
// but QLever requires explicitly.
const WIKIDATA_PREFIXES = `
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

// Scholarly article instance-of QIDs that live in the split-off graph
const SCHOLARLY_QIDS = new Set([
	"Q13442814", // scholarly article
	"Q191067",   // article
	"Q17928402", // scientific article
	"Q18918145", // academic journal article
	"Q23927052", // conference paper
	"Q87715823", // preprint
	"Q580922",   // review article
]);

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

/**
 * Run a SPARQL SELECT query against the given endpoint and return raw bindings.
 */
async function runSparql(
	endpoint: string,
	query: string,
): Promise<any[]> {
	const url = `${endpoint}?query=${encodeURIComponent(query)}&format=json`;
	try {
		const response = await requestUrl({
			url,
			headers: {
				// QLever requires an explicit Accept header for JSON
				Accept: "application/sparql-results+json",
			},
		});
		return response.json?.results?.bindings ?? [];
	} catch (e) {
		console.warn(`SPARQL query failed for endpoint ${endpoint}:`, e);
		return [];
	}
}

/**
 * Check whether a Wikidata entity is a scholarly article by querying
 * QLever for its instance-of values.
 */
async function isScholarlyEntity(id: string): Promise<boolean> {
	const query = WIKIDATA_PREFIXES + `
		SELECT ?type WHERE {
			wd:${id} wdt:P31 ?type .
		}
		LIMIT 20
	`;
	const bindings = await runSparql(QLEVER_SPARQL, query);
	for (const b of bindings) {
		const typeUrl: string = b.type?.value ?? "";
		const qid = typeUrl.match(/Q\d+$/)?.[0];
		if (qid && SCHOLARLY_QIDS.has(`Q${qid.replace(/^Q/, "")}`)) {
			return true;
		}
	}
	return false;
}

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
		// support multiple comma-separated languages like "mul,en"
		const languages = opts.language
			.split(",")
			.map((l) => l.trim().toLowerCase())
			.filter(Boolean);
		const allResults = new Map<string, Entity>();
		for (const lang of languages) {
			const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&uselang=${lang}&type=item&limit=10&search=${encodeURIComponent(query)}`;
			console.log("Wikidata search:", url);
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
					`Wikidata search failed for language "${lang}":`,
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
	) {
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

	/**
	 * Build the SPARQL query body used by both endpoints.
	 * `serviceBlock` is injected differently per endpoint since QLever
	 * does not support the wikibase:label SERVICE — labels must be
	 * fetched via rdfs:label directly.
	 */
	private buildPropertiesQuery(
		opts: GetPropertiesOptions,
		useRdfsLabel: boolean,
	): string {
		const labelFragment = useRdfsLabel
			? `
				OPTIONAL { ?property rdfs:label ?propertyLabel . FILTER(LANG(?propertyLabel) = "${opts.language}") }
				OPTIONAL { ?value rdfs:label ?valueLabel . FILTER(LANG(?valueLabel) = "${opts.language}") }
			`
			: `
				SERVICE wikibase:label {
					bd:serviceParam wikibase:language "[AUTO_LANGUAGE],${opts.language}" .
				}
			`;

		let query = `
			SELECT ?propertyLabel ?value ?valueLabel ?valueType ?normalizedValue ?description WHERE {
				wd:${this.id} ?propUrl ?value .
				?property wikibase:directClaim ?propUrl .
				OPTIONAL { wd:${this.id} schema:description ?description . FILTER (LANG(?description) = "${opts.language}") }
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

		query += labelFragment + `}`;

		return query;
	}

	/**
	 * Parse raw SPARQL bindings into a Properties map, merging into `ret`.
	 * Existing keys are extended rather than overwritten so results from
	 * multiple endpoints can be combined cleanly.
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

			const normalizedValue: string | null = r.normalizedValue
				? r.normalizedValue.value
				: null;
			const type: string | null = r.valueType ? r.valueType.value : null;
			const valueLabel: string | null = r.valueLabel
				? r.valueLabel.value
				: null;

			if (
				opts.ignoreCategories &&
				valueLabel &&
				valueLabel.startsWith("Category:")
			) {
				continue;
			}

			if (
				opts.ignoreWikipediaPages &&
				valueLabel &&
				valueLabel.startsWith("Wikipedia:")
			) {
				continue;
			}

			if (opts.ignoreIDs && key.match(/\bID\b/)) {
				continue;
			}

			if (opts.spaceReplacement && opts.spaceReplacement.length > 0) {
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
				const id = value.match(/\d+$/);
				if (!id) continue;
				const label = Entity.buildLink(
					opts.internalLinkPrefix,
					valueLabel,
					id[0],
				);
				toAdd = `[[${label}]]`;
			}

			if (toAdd === null) continue;

			// Deduplicate values per key across merged endpoint results
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

	async getProperties(opts: GetPropertiesOptions): Promise<Properties> {
		const ret: Properties = {};

		// --- 1. Query the standard Wikidata SPARQL endpoint ---
		const wdQuery = this.buildPropertiesQuery(opts, false);
		const wdResults = await runSparql(WIKIDATA_SPARQL, wdQuery);
		this.parseBindings(wdResults, opts, ret);

		// --- 2. Always also query QLever (which has the full graph
		//        including scholarly articles) and merge any extra statements.
		//        QLever does not support wikibase:label SERVICE, so we use
		//        rdfs:label instead. ---
		const qlQuery = WIKIDATA_PREFIXES + this.buildPropertiesQuery(opts, true);
		const qlResults = await runSparql(QLEVER_SPARQL, qlQuery);
		this.parseBindings(qlResults, opts, ret);

		return ret;
	}
}
