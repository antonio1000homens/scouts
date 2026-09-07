// Stable Lambda handler entrypoint retained for deployment compatibility.
// The provider wrapper owns image-stage dispatch and delegates all existing
// full-enrich behavior to full-enrich-core.mjs.
export { lambdaHandler } from './image-provider-adapter.mjs';
