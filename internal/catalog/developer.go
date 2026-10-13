package catalog

import (
	"sort"
	"strings"
)

// developerPrefix 把目录里的 family 前缀映射到研发商展示名。
// 未识别时返回空串, 由界面显示为「其他」。
// 短前缀必须用 requireDigit 之类的守卫, 否则 ornith、osmosis 这类家族会被误认成 OpenAI 的 o 系列;
// 反过来, glm 故意不加守卫, 因为 models.dev 里还有 glmv 这个视觉家族也属智谱。
type developerPrefix struct {
	prefix       string
	developer    string
	requireDigit bool // 前缀后必须是数字, 用于 o1/o3 与 hy3 这类短前缀
}

var developerPrefixes = []developerPrefix{
	{"gpt", "OpenAI", false},
	{"codex", "OpenAI", false},
	{"o", "OpenAI", true},
	{"claude", "Anthropic", false},
	{"gemini", "Google", false},
	{"gemma", "Google", false},
	{"veo", "Google", false},
	{"lyria", "Google", false},
	{"imagen", "Google", false},
	{"deepseek", "DeepSeek", false},
	{"grok", "xAI", false},
	{"qwen", "Alibaba", false},
	{"qvq", "Alibaba", false},
	{"glm", "Zhipu AI", false},
	{"cogview", "Zhipu AI", false},
	{"cogvlm", "Zhipu AI", false},
	{"minimax", "MiniMax", false},
	{"abab", "MiniMax", false},
	{"kimi", "Moonshot AI", false},
	{"moonshot", "Moonshot AI", false},
	{"mimo", "Xiaomi", false},
	{"llama", "Meta", false},
	{"magistral", "Mistral", false},
	{"codestral", "Mistral", false},
	{"devstral", "Mistral", false},
	{"pixtral", "Mistral", false},
	{"voxtral", "Mistral", false},
	{"mistral", "Mistral", false},
	{"nemotron", "NVIDIA", false},
	{"doubao", "ByteDance", false},
	{"seed", "ByteDance", false},
	{"hunyuan", "Tencent", false},
	{"hy", "Tencent", true},
	{"ernie", "Baidu", false},
	{"step", "StepFun", false},
	{"ling", "InclusionAI", false},
	{"ring", "InclusionAI", false},
	{"phi", "Microsoft", false},
	{"nova", "Amazon", false},
	{"titan", "Amazon", false},
	{"command", "Cohere", false},
	{"aya", "Cohere", false},
	{"jamba", "AI21", false},
	{"sonar", "Perplexity", false},
	{"granite", "IBM", false},
	{"olmo", "Allen AI", false},
	{"dbrx", "Databricks", false},
	{"arctic", "Snowflake", false},
	{"reka", "Reka", false},
	{"spark", "iFlytek", false},
	{"baichuan", "Baichuan", false},
	{"internlm", "Shanghai AI Lab", false},
	{"minicpm", "OpenBMB", false},
	{"v0", "Vercel", false},
	{"yi", "01.AI", false},
}

func init() {
	// 长前缀优先, 避免 hy 抢在 hunyuan 之前命中。
	sort.SliceStable(developerPrefixes, func(i, j int) bool {
		return len(developerPrefixes[i].prefix) > len(developerPrefixes[j].prefix)
	})
}

// Developer 依据 family 判断研发商, 认不出来时返回空串。
func Developer(family string) string {
	name := strings.ToLower(strings.TrimSpace(family))
	if name == "" {
		return ""
	}
	for _, rule := range developerPrefixes {
		if !strings.HasPrefix(name, rule.prefix) {
			continue
		}
		rest := name[len(rule.prefix):]
		if rule.requireDigit {
			if rest == "" || rest[0] < '0' || rest[0] > '9' {
				continue
			}
		}
		return rule.developer
	}
	return ""
}
