/**
 * Report which models the configured upstream actually serves, and whether each
 * curated quick-switch preset resolves to a name the upstream advertises.
 *
 *   node scripts/models-status.mjs
 *
 * Runs against an isolated copy of the config, so it can never modify your settings.
 */
import "./_isolate.mjs";

const { loadConfig, listUpstreamModels, describeCuratedModels } = await import("../src/config.js");

const config = loadConfig();
console.log("provider:", config.provider, `(${config.providerLabel})`);
console.log("baseUrl :", config.baseUrl || "(未配置)");
console.log("model   :", config.model || "(未配置)");
console.log("planner :", config.plannerModel || "(同生成模型)");
console.log("apiKey  :", config.apiKey ? `已配置（来源：${config.apiKeySource}）` : "未配置");
console.log();

const upstream = await listUpstreamModels(config, { force: true });
if (upstream.models.length) {
  console.log(`上游 /models 可达：${upstream.models.length} 个模型`);
} else {
  console.log(`上游 /models 不可达：${upstream.error}`);
}
console.log();

for (const entry of describeCuratedModels(upstream.models)) {
  const flag = entry.available === true ? "可用" : entry.available === false ? "上游未列出" : "无法判断";
  const active = entry.model === config.model ? "  ← 当前使用" : "";
  console.log(`  ${entry.label.padEnd(22)} ${entry.model.padEnd(26)} ${flag}${active}`);
}
