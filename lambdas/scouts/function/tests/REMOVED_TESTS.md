The following OAuth/OSM-related test files were neutralized and should be removed from the repository:

- test-correct-params.mjs
- test-endpoints.mjs
- test-events-summary.mjs
- test-final-oauth.mjs
- test-lambda-oauth.mjs
- test-oauth-final.mjs
- test-oauth-flow.mjs
- test-oauth-scopes.mjs
- test-oauth-summary.mjs
- test-osm-api.mjs
- test-scopes.mjs
- test-simple-oauth.mjs
- test-valid-terms.mjs

These files were replaced with inert stubs to remove any references to OSM credentials. If you want to fully delete them from the filesystem/repo, run the script at `scripts/remove_osm_tests.sh` in the repository root (zsh).