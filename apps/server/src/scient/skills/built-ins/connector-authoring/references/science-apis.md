# Scholarly API coverage

Before implementing, read the service's current official documentation for endpoints, authentication, rate limits and paging, and record the URL, date and tested endpoint in the connector README. Use the response's rate-limit headers, timeouts and bounded backoff; the budget is shared across the user's programs. Treat quotas in old examples as history, not guarantees.

- [OpenAlex](https://docs.openalex.org/): offset paging stops at 10,000 results, so `has_more: false` there doesn't mean the search is complete; the template reports `truncated` with a reason. Check the current authentication and paging rules (cursor paging may need an API key). For a complete search, implement documented cursor paging or disjoint partitions and reconcile totals, and disclose unfinished work. Author lists and abstracts can also be cut.
- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/): PubMed ESearch exposes only the first 10,000 IDs, and `retstart` or history alone doesn't get past that. Use NCBI's supported large-search or bulk route, or validated non-overlapping queries; keep raw counts and deduplicate overlaps. Verify the cap for each database.
- [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/): DOI metadata is not full text; follow its cursor and rate-limit rules.
- [arXiv](https://info.arxiv.org/help/api/user-manual.html): keep the identifier version, parse Atom, and pace calls to its shared limits.
- [Semantic Scholar](https://api.semanticscholar.org/api-docs/): ranked search and bulk search differ in coverage and pagination; choose for the task.
- [ClinicalTrials.gov](https://clinicaltrials.gov/data-api/api): trial records are not publications; keep the registry ID, update date and page token.
- [Zotero](https://www.zotero.org/support/dev/web_api/v3/basics): keep library and item IDs, versions and next-page links, and back off when asked; the local and web APIs differ in capabilities.

Every result states its source, stable IDs, coverage, pages completed and any cap or omitted fields. An HTTP 200 or a search total doesn't prove all records came back. Resolve conflicting identifiers before merging works.
