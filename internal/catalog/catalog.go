package catalog

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Entry 是目录条目在内存里的形态。
type Entry struct {
	ModelID       string
	Name          string
	Identity      string // 归一化后的模型身份, 同一模型的多种写法共用
	Developer     string // 研发商展示名, 空表示未识别
	Family        string
	ReleaseDate   string
	ToolCall      bool
	ContextWindow int
	Status        string
}

var (
	lock       sync.RWMutex
	byIdentity = map[string]Entry{}
	byModelID  = map[string]string{}
	bySoft     = map[string]string{}
	byHard     = map[string]string{}
	fuzzyKeys  []string
	updatedAt  time.Time
	// entryCount 是最近一次装载的原始条目数, 与身份数不同: 同一个身份可能对应多个上游写法。
	entryCount int
)

// Replace 用新的目录内容替换内存索引, at 表示这批数据的更新时间。
func Replace(entries []Entry, at time.Time) {
	identities := make(map[string]Entry, len(entries))
	modelIDs := make(map[string]string, len(entries))
	softs := make(map[string]string, len(entries))
	hards := make(map[string]string, len(entries))
	for _, entry := range entries {
		if entry.Identity == "" {
			continue
		}
		if current, ok := identities[entry.Identity]; !ok || preferEntry(entry, current) {
			identities[entry.Identity] = entry
		}
		modelIDs[strings.ToLower(entry.ModelID)] = entry.Identity
		if soft := Normalize(entry.ModelID); soft != "" {
			if _, ok := softs[soft]; !ok {
				softs[soft] = entry.Identity
			}
		}
		if hard := StrictNormalize(entry.ModelID); hard != "" {
			if _, ok := hards[hard]; !ok {
				hards[hard] = entry.Identity
			}
		}
	}
	fuzzy := make([]string, 0, len(hards))
	for hard := range hards {
		// 过短的候选(pro、mini、small)容易吃掉无关模型, 兜底匹配只用带连字符的长名字。
		if len(hard) >= 8 && strings.Contains(hard, "-") {
			fuzzy = append(fuzzy, hard)
		}
	}
	sort.Slice(fuzzy, func(i, j int) bool {
		if len(fuzzy[i]) != len(fuzzy[j]) {
			return len(fuzzy[i]) > len(fuzzy[j])
		}
		return fuzzy[i] < fuzzy[j]
	})
	lock.Lock()
	byIdentity, byModelID, bySoft, byHard, fuzzyKeys = identities, modelIDs, softs, hards, fuzzy
	// 用数据自身的时间戳: 重启后从库里装载时, 界面显示的更新时间才是这批目录的抓取时间, 而不是进程启动时间。
	if at.IsZero() {
		at = time.Now()
	}
	updatedAt = at
	entryCount = len(entries)
	lock.Unlock()
}

// preferEntry 选出同一身份的代表条目: 优先身份自身, 其次发布时间更新的那份。
func preferEntry(candidate, current Entry) bool {
	candidateIsIdentity := strings.EqualFold(candidate.ModelID, candidate.Identity)
	currentIsIdentity := strings.EqualFold(current.ModelID, current.Identity)
	if candidateIsIdentity != currentIsIdentity {
		return candidateIsIdentity
	}
	return candidate.ReleaseDate > current.ReleaseDate
}

// Resolve 把渠道里的模型名解析到目录条目: 原始 id、归一化、严格归一化, 最后是前后缀兜底。
func Resolve(name string) (Entry, bool) {
	trimmed := strings.ToLower(strings.TrimSpace(name))
	if trimmed == "" {
		return Entry{}, false
	}
	lock.RLock()
	defer lock.RUnlock()
	if identity, ok := byModelID[trimmed]; ok {
		return entryOf(identity)
	}
	soft := Normalize(name)
	if identity, ok := bySoft[soft]; ok {
		return entryOf(identity)
	}
	hard := StrictNormalize(name)
	if identity, ok := byHard[hard]; ok {
		return entryOf(identity)
	}
	for _, candidate := range fuzzyKeys {
		if len(candidate)*2 < len(hard) {
			break
		}
		if strings.HasSuffix(hard, candidate) && isSeparator(hard[len(hard)-len(candidate)-1]) {
			return entryOf(byHard[candidate])
		}
		if strings.HasPrefix(hard, candidate) && len(hard) > len(candidate) && isSeparator(hard[len(candidate)]) {
			return entryOf(byHard[candidate])
		}
	}
	return Entry{}, false
}

func entryOf(identity string) (Entry, bool) {
	entry, ok := byIdentity[identity]
	if !ok {
		return Entry{}, false
	}
	return entry, true
}

func isSeparator(char byte) bool {
	return char == '-' || char == '.' || char == '_' || char == '/'
}

// Count 返回目录里的模型身份数量。
func Count() int {
	lock.RLock()
	defer lock.RUnlock()
	return len(byIdentity)
}

// Size 返回最近一次装载的原始条目数。
func Size() int {
	lock.RLock()
	defer lock.RUnlock()
	return entryCount
}

// UpdatedAt 返回最近一次目录更新时间。
func UpdatedAt() time.Time {
	lock.RLock()
	defer lock.RUnlock()
	return updatedAt
}
