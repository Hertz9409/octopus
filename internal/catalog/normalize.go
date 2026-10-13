package catalog

import (
	"regexp"
	"sort"
	"strings"
)

// vendorTokens 是托管方或聚合方写在模型名里的前缀标识, 归一化时去掉它们。
// 只收录会以前缀形式出现的常见标识, 避免误伤以点号分隔版本号的模型名(如 mimo.v2.6-pro)。
var vendorTokens = map[string]bool{
	"anthropic": true, "openai": true, "google": true, "meta": true, "microsoft": true,
	"amazon": true, "aws": true, "azure": true, "vertex": true, "databricks": true,
	"mistral": true, "mistralai": true, "qwen": true, "alibaba": true, "deepseek": true,
	"deepseek-ai": true, "xai": true, "cohere": true, "nvidia": true, "groq": true,
	"together": true, "fireworks": true, "openrouter": true, "deepinfra": true,
	"cerebras": true, "sambanova": true, "perplexity": true, "moonshot": true,
	"moonshotai": true, "zhipu": true, "zhipuai": true, "tencent": true, "baidu": true,
	"bytedance": true, "stepfun": true, "inclusionai": true, "minimax": true,
	"xiaomi": true, "xiaomimimo": true, "v0": true, "novita": true, "hyperbolic": true,
	"lambda": true, "lepton": true, "nscale": true, "baseten": true, "cloudflare": true,
}

var regionPrefixes = []string{
	"us-gov.", "us.", "eu.", "jp.", "au.", "global.", "apac.", "ca.", "sa.", "me.",
	"af.", "il.", "mx.", "uk.", "ap.", "cn.", "kr.", "in.",
}

// vendorTokenOrder 把前缀剥离的顺序固定下来: 长前缀优先, 且与 map 迭代顺序无关。
// 否则 deepseek-ai-deepseek-v3 可能被 deepseek 先吃掉一半, 归一化结果随每次进程运行而变。
var vendorTokenOrder = func() []string {
	tokens := make([]string, 0, len(vendorTokens))
	for token := range vendorTokens {
		tokens = append(tokens, token)
	}
	sort.Slice(tokens, func(i, j int) bool {
		if len(tokens[i]) != len(tokens[j]) {
			return len(tokens[i]) > len(tokens[j])
		}
		return tokens[i] < tokens[j]
	})
	return tokens
}()

// variantSuffixes 是不改变模型身份的常见后缀, 只在兜底匹配时去掉。
var variantSuffixes = []string{
	"-chat-latest", "-experimental", "-thinking", "-preview", "-latest", "-think",
	"-turbo", "-fast", "-high", "-medium", "-low", "-exp",
}

var (
	bedrockVersionSuffix = regexp.MustCompile(`-v\d+:\d+$`)
	dateSuffix           = regexp.MustCompile(`[-@]20\d{2}-?\d{2}-?\d{2}$`)
	yearSuffix           = regexp.MustCompile(`[-@]20\d{2}$`)
	dashRuns             = regexp.MustCompile(`-+`)
	dotVendorPrefix      = regexp.MustCompile(`^([a-z0-9]+)\.(.+)$`)
)

// Normalize 统一大小写、供应商前缀与分隔符, 保留区分模型的部分。
// 渠道里常见的写法(anthropic/claude-sonnet-4.5、us.anthropic.claude-...-v1:0)在这里收敛到同一形态。
func Normalize(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	if name == "" {
		return ""
	}
	name = bedrockVersionSuffix.ReplaceAllString(name, "")
	// 冒号后面是聚合方的档位标签(:free、:nitro)或 Ollama 的量化标签(:32b), 都不改变模型身份。
	if index := strings.Index(name, ":"); index >= 0 {
		name = name[:index]
	}
	if index := strings.LastIndex(name, "/"); index >= 0 {
		name = name[index+1:]
	}
	for _, prefix := range regionPrefixes {
		if strings.HasPrefix(name, prefix) {
			name = name[len(prefix):]
			break
		}
	}
	if match := dotVendorPrefix.FindStringSubmatch(name); match != nil && vendorTokens[match[1]] {
		name = match[2]
	}
	name = dashRuns.ReplaceAllString(strings.NewReplacer(".", "-", "_", "-").Replace(name), "-")
	name = strings.Trim(name, "-")
	for _, token := range vendorTokenOrder {
		if strings.HasPrefix(name, token+"-") && len(name) > len(token)+3 {
			name = name[len(token)+1:]
			break
		}
	}
	return name
}

// StrictNormalize 在 Normalize 的基础上再去掉日期与变体后缀, 用于兜底匹配。
func StrictNormalize(raw string) string {
	name := Normalize(raw)
	if name == "" {
		return ""
	}
	name = dateSuffix.ReplaceAllString(name, "")
	name = yearSuffix.ReplaceAllString(name, "")
	for changed := true; changed; {
		changed = false
		for _, suffix := range variantSuffixes {
			if strings.HasSuffix(name, suffix) && len(name) > len(suffix) {
				name = name[:len(name)-len(suffix)]
				changed = true
			}
		}
	}
	return strings.Trim(name, "-")
}
