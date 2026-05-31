/**
 * Argus Analyzer Plugin Registry
 *
 * Analyzers self-register at module load time by calling registerCheap()
 * or registerExpensive(). The orchestrator iterates getCheap() / getExpensive()
 * instead of 14+ named function calls — adding a new detector = 1 file only.
 *
 * clearAll() is a test helper — do not call in production code.
 */

const _cheap     = [];
const _expensive = [];

export const registerCheap      = (analyzer) => _cheap.push(analyzer);
export const registerExpensive  = (analyzer) => _expensive.push(analyzer);
export const getCheap           = () => [..._cheap];
export const getExpensive       = () => [..._expensive];
export const clearAll           = () => { _cheap.length = 0; _expensive.length = 0; };
