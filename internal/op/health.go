package op

import (
	"sync"
	"time"

	"github.com/bestruirui/octopus/internal/model"
)

// 健康状态的窗口与节流: 被动流量只统计最近 5 分钟(按 10 秒分桶),
// 5 分钟内的手动探测结果优先于被动流量; 同一渠道两次手动探测至少间隔 60 秒。
const (
	healthWindowMs = int64(5 * time.Minute / time.Millisecond)
	healthBucketMs = int64(10 * time.Second / time.Millisecond)
	probeCooldown  = 60 * time.Second
)

// healthBucket 是窗口内的一个时间桶; lastOK/lastFail 记录桶内最后一次成功/失败时刻。
type healthBucket struct {
	start    int64
	success  int64
	failure  int64
	lastOK   int64
	lastFail int64
}

var (
	healthMu       sync.Mutex
	channelProbes  = make(map[int]model.ChannelProbeResult) // 渠道最近一次手动探测结果。
	probeInFlight  = make(map[int]int64)                    // 渠道正在进行的探测开始时刻(Unix 毫秒), 用于并发占用名额。
	channelTraffic = make(map[int][]healthBucket)           // 渠道被动流量窗口。
	modelTraffic   = make(map[int][]healthBucket)           // 模型被动流量窗口。
)

// recordBucket 把一次结果写入窗口并裁掉过期桶, 返回更新后的切片。
// 桶按时间升序追加, 只会有尾部是当前桶, 故顺序扫描即可。
func recordBucket(buckets []healthBucket, at int64, ok bool) []healthBucket {
	start := at - at%healthBucketMs
	cutoff := at - healthWindowMs
	kept := buckets[:0]
	for _, bucket := range buckets {
		if bucket.start >= cutoff {
			kept = append(kept, bucket)
		}
	}
	buckets = kept

	if n := len(buckets); n > 0 && buckets[n-1].start == start {
		bucket := &buckets[n-1]
		if ok {
			bucket.success++
			bucket.lastOK = at
		} else {
			bucket.failure++
			bucket.lastFail = at
		}
		return buckets
	}

	bucket := healthBucket{start: start}
	if ok {
		bucket.success = 1
		bucket.lastOK = at
	} else {
		bucket.failure = 1
		bucket.lastFail = at
	}
	return append(buckets, bucket)
}

// snapshotTraffic 汇总窗口内的成功/失败与最后一次成功/失败时刻。
func snapshotTraffic(buckets []healthBucket, at int64) model.ChannelTraffic {
	cutoff := at - healthWindowMs
	var traffic model.ChannelTraffic
	for _, bucket := range buckets {
		if bucket.start < cutoff {
			continue
		}
		traffic.Success += bucket.success
		traffic.Failure += bucket.failure
		if bucket.lastOK > traffic.LastOKAt {
			traffic.LastOKAt = bucket.lastOK
		}
		if bucket.lastFail > traffic.LastFailAt {
			traffic.LastFailAt = bucket.lastFail
		}
	}
	return traffic
}

// recordChannelTraffic 记录一次真实转发结果到渠道窗口。
func recordChannelTraffic(channelID int, ok bool) {
	healthMu.Lock()
	defer healthMu.Unlock()
	channelTraffic[channelID] = recordBucket(channelTraffic[channelID], time.Now().UnixMilli(), ok)
}

// recordModelTraffic 记录一次真实转发结果到模型窗口。
func recordModelTraffic(modelID int, ok bool) {
	healthMu.Lock()
	defer healthMu.Unlock()
	modelTraffic[modelID] = recordBucket(modelTraffic[modelID], time.Now().UnixMilli(), ok)
}

// RecordChannelProbe 保存渠道最近一次手动连通性探测结果, 并释放该渠道的探测占用。
func RecordChannelProbe(channelID int, probe model.ChannelProbeResult) {
	healthMu.Lock()
	defer healthMu.Unlock()
	channelProbes[channelID] = probe
	delete(probeInFlight, channelID)
}

// TryBeginProbe 原子地判断冷却并占用一次探测名额。
// 冷却未到, 或该渠道已有探测在途时返回 (剩余等待, false); 可以探测时登记占用并返回 (0, true),
// 由调用方在探测完成时 RecordChannelProbe 或异常时 AbortProbe 释放。检查与占用在同一把锁内, 并发请求不会同时通过。
func TryBeginProbe(channelID int) (time.Duration, bool) {
	healthMu.Lock()
	defer healthMu.Unlock()

	now := time.Now().UnixMilli()
	if startedAt, busy := probeInFlight[channelID]; busy {
		remain := probeCooldown - time.Duration(now-startedAt)*time.Millisecond
		if remain < 0 {
			remain = 0
		}
		return remain, false
	}
	if probe, ok := channelProbes[channelID]; ok {
		if remain := probeCooldown - time.Duration(now-probe.At)*time.Millisecond; remain > 0 {
			return remain, false
		}
	}
	probeInFlight[channelID] = now
	return 0, true
}

// AbortProbe 释放一次未产出结果的探测占用, 供调用方在提前返回或异常路径上归还名额。
func AbortProbe(channelID int) {
	healthMu.Lock()
	defer healthMu.Unlock()
	delete(probeInFlight, channelID)
}

// deriveStatus 由探测与被动流量得出状态: 5 分钟内的探测优先, 其次看流量。
// 判定口径: 全成功=healthy, 有成功有失败=degraded, 全失败=down, 无数据=unknown。
// 探测未覆盖任何凭据(KeysTotal==0, 例如没有启用且填了密钥的凭据, 或客户端/代理配置走不通)属于"无法判定", 记 unknown 而非 down。
func deriveStatus(enabled bool, probe *model.ChannelProbeResult, traffic model.ChannelTraffic, now int64) string {
	if !enabled {
		return "unknown"
	}
	if probe != nil && now-probe.At <= healthWindowMs {
		if probe.KeysTotal == 0 {
			return "unknown"
		}
		if probe.OK {
			return "healthy"
		}
		return "down"
	}
	if traffic.Success+traffic.Failure == 0 {
		return "unknown"
	}
	if traffic.Failure == 0 {
		return "healthy"
	}
	if traffic.Success > 0 {
		return "degraded"
	}
	return "down"
}

// ChannelHealthSnapshot 汇总渠道的探测与被动流量; 两者都无信号时返回 nil, 由调用方整块省略。
func ChannelHealthSnapshot(channelID int, enabled bool) *model.ChannelHealth {
	healthMu.Lock()
	defer healthMu.Unlock()

	now := time.Now().UnixMilli()
	probe, hasProbe := channelProbes[channelID]
	traffic := snapshotTraffic(channelTraffic[channelID], now)
	if !hasProbe && traffic.Success == 0 && traffic.Failure == 0 {
		return nil
	}

	health := &model.ChannelHealth{
		Status:  deriveStatus(enabled, nil, traffic, now),
		Traffic: traffic,
	}
	if hasProbe {
		snapshot := probe
		health.Probe = &snapshot
		health.Status = deriveStatus(enabled, &snapshot, traffic, now)
	}
	return health
}

// ModelHealthSnapshot 汇总模型的被动流量健康; 没有流量时返回 nil。
func ModelHealthSnapshot(modelID int) *model.ChannelModelHealth {
	healthMu.Lock()
	defer healthMu.Unlock()

	now := time.Now().UnixMilli()
	traffic := snapshotTraffic(modelTraffic[modelID], now)
	if traffic.Success == 0 && traffic.Failure == 0 {
		return nil
	}
	return &model.ChannelModelHealth{
		Status:  deriveStatus(true, nil, traffic, now),
		Traffic: traffic,
	}
}

// deleteChannelHealth 丢弃渠道及其模型的健康状态, 供渠道删除时清理。
func deleteChannelHealth(channelID int, modelIDs []int) {
	healthMu.Lock()
	defer healthMu.Unlock()
	delete(channelProbes, channelID)
	delete(probeInFlight, channelID)
	delete(channelTraffic, channelID)
	for _, modelID := range modelIDs {
		delete(modelTraffic, modelID)
	}
}

// pruneModelHealth 丢弃已不存在的模型对应的健康窗口。
// 模型删除走 syncChannelModels(渠道更新/同步模型), 不经过 ChannelDel, 故需在渠道更新后按当前模型缓存清扫,
// 否则每删除一个模型就会在 modelTraffic 里常驻一条窗口数据。
func pruneModelHealth() {
	healthMu.Lock()
	defer healthMu.Unlock()
	for modelID := range modelTraffic {
		if _, ok := channelModelCache.Get(modelID); !ok {
			delete(modelTraffic, modelID)
		}
	}
}
