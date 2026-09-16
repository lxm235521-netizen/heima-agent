/**
 * Compare the two planning strategies on the same input, so the trade-off is measured
 * rather than asserted. Costs two real generations.
 *
 *   node scripts/deep-compare.mjs
 */
import "./_isolate.mjs";

const { runGeneration } = await import("../src/generate.mjs");
const { loadConfig } = await import("../src/config.js");

const config = loadConfig();
if (!config.apiKey) {
  console.error("未配置 API Key，无法实测。");
  process.exit(1);
}

const TEXT = `深夜的旧仓库。老陈推开锈迹斑斑的铁门，手电光柱扫过满地纸箱，灰尘在光里翻涌。他身后跟着十七岁的小满，抱着一台旧录音机。

老陈压低声音：东西还在。
小满紧张地咽了口唾沫：爸，外面有人。
铁门外传来脚步踩碎玻璃的声音，越来越近。老陈一把按灭手电，黑暗里只剩录音机红色的指示灯在闪。`;

async function run(label, deepDive) {
  console.log(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}`);
  const stages = [];
  let plan = null;
  let result = null;
  let failure = null;
  let usage = null;
  const t0 = Date.now();

  for await (const ev of runGeneration(config, { text: TEXT, durationSec: 10, ratio: "16:9", mode: "auto", deepDive })) {
    if (ev.type === "stage") stages.push(ev.stage);
    else if (ev.type === "plan") plan = ev.plan;
    else if (ev.type === "result") { result = ev.result; usage = ev.usage; }
    else if (ev.type === "error") failure = ev.message;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("阶段        :", stages.join(" -> "));
  console.log("规划阶段    :", plan ? `已执行（判定 ${plan.mode}，置信度 ${plan.confidence}）` : "已跳过");
  console.log("耗时        :", `${elapsed}s`);
  if (failure) {
    console.log("失败        :", failure);
    return { label, failed: true };
  }
  console.log("最终模式    :", result.mode);
  console.log("校验        :", `${result.validation.errors.length} errors / ${result.validation.warnings.length} warnings`);
  console.log("修复次数    :", result.repairs);
  console.log("提示词长度  :", `${result.prompt.length} 字符 / ${result.validation.stats.words} 词`);
  console.log("token 用量  :", usage ? `prompt ${usage.prompt_tokens} + completion ${usage.completion_tokens} = ${usage.total_tokens}` : "未上报");
  return {
    label,
    failed: false,
    mode: result.mode,
    errors: result.validation.errors.length,
    warnings: result.validation.warnings.length,
    words: result.validation.stats.words,
    elapsed,
    tokens: usage?.total_tokens ?? null,
  };
}

const a = await run("A · 标准模式（两步：先规划，再生成）", false);
const b = await run("B · 深度模式（一步：直接生成）", true);

console.log(`\n${"=".repeat(64)}\n汇总\n${"=".repeat(64)}`);
for (const r of [a, b]) {
  console.log(
    r.failed
      ? `${r.label}: 失败`
      : `${r.label}: 模式=${r.mode} 耗时=${r.elapsed}s 词数=${r.words} 校验=${r.errors}错误/${r.warnings}警告`,
  );
}
