/**
 * Starts the bundled mock model on all interfaces so a Docker container can reach it
 * via host.docker.internal. Lets the container be verified end to end with no real
 * API key.
 *
 *   node scripts/mock-upstream.mjs [port]
 */
import "./_isolate.mjs"; // keep any config access off the real config.local.json
import { startMockLlm } from "../test/mock-llm.mjs";

const port = Number(process.argv[2] ?? 3111);
const { baseUrl } = await startMockLlm({ port, host: "0.0.0.0" });
console.log(`mock upstream listening on port ${port}`);
console.log(`  from the host:      ${baseUrl}`);
console.log(`  from a container:   http://host.docker.internal:${port}/v1`);
