package op

import (
	"testing"
	"time"

	"github.com/bestruirui/octopus/internal/model"
)

func TestRecordBucketAndSnapshot(t *testing.T) {
	var buckets []healthBucket
	base := int64(1_700_000_000_000)
	buckets = recordBucket(buckets, base, true)
	buckets = recordBucket(buckets, base+1000, false)

	traffic := snapshotTraffic(buckets, base+2000)
	if traffic.Success != 1 || traffic.Failure != 1 {
		t.Fatalf("want 1 success / 1 failure, got %+v", traffic)
	}
	if traffic.LastOKAt != base || traffic.LastFailAt != base+1000 {
		t.Fatalf("last times wrong: %+v", traffic)
	}

	// 窗口外的数据不计入。
	traffic = snapshotTraffic(buckets, base+healthWindowMs+20000)
	if traffic.Success != 0 || traffic.Failure != 0 {
		t.Fatalf("expected pruned window, got %+v", traffic)
	}
}

func TestDeriveStatus(t *testing.T) {
	now := int64(1_700_000_000_000)
	ok := func(keysTotal int) *model.ChannelProbeResult {
		return &model.ChannelProbeResult{OK: true, At: now, KeysTotal: keysTotal}
	}
	bad := func(keysTotal int) *model.ChannelProbeResult {
		return &model.ChannelProbeResult{OK: false, At: now, KeysTotal: keysTotal}
	}

	cases := []struct {
		name    string
		enabled bool
		probe   *model.ChannelProbeResult
		traffic model.ChannelTraffic
		want    string
	}{
		{"probe ok", true, ok(1), model.ChannelTraffic{}, "healthy"},
		{"probe all failed", true, bad(2), model.ChannelTraffic{}, "down"},
		{"probe no credential", true, bad(0), model.ChannelTraffic{}, "unknown"},
		{"traffic all ok", true, nil, model.ChannelTraffic{Success: 3}, "healthy"},
		{"traffic mixed", true, nil, model.ChannelTraffic{Success: 2, Failure: 1}, "degraded"},
		{"traffic all fail", true, nil, model.ChannelTraffic{Failure: 2}, "down"},
		{"no signal", true, nil, model.ChannelTraffic{}, "unknown"},
		{"disabled", false, ok(1), model.ChannelTraffic{}, "unknown"},
	}
	for _, c := range cases {
		if got := deriveStatus(c.enabled, c.probe, c.traffic, now); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestPruneModelHealthRemovesDeletedModel(t *testing.T) {
	const liveModelID, deletedModelID = 900001, 900002
	t.Cleanup(func() {
		healthMu.Lock()
		delete(modelTraffic, liveModelID)
		delete(modelTraffic, deletedModelID)
		healthMu.Unlock()
		channelModelCache.Del(liveModelID)
	})

	channelModelCache.Set(liveModelID, model.ChannelModel{ID: liveModelID, Name: "live"})
	recordModelTraffic(liveModelID, true)
	recordModelTraffic(deletedModelID, true)

	pruneModelHealth()

	if ModelHealthSnapshot(liveModelID) == nil {
		t.Fatalf("live model health should be kept")
	}
	if ModelHealthSnapshot(deletedModelID) != nil {
		t.Fatalf("deleted model health should be pruned")
	}
}

func TestTryBeginProbeIsAtomic(t *testing.T) {
	const channelID = 900010
	t.Cleanup(func() {
		healthMu.Lock()
		delete(channelProbes, channelID)
		delete(probeInFlight, channelID)
		healthMu.Unlock()
	})

	// 首次占用成功。
	if remain, ok := TryBeginProbe(channelID); !ok || remain != 0 {
		t.Fatalf("first probe should be allowed, remain=%v ok=%v", remain, ok)
	}
	// 在途时第二次必须被拒绝(并发占用)。
	if _, ok := TryBeginProbe(channelID); ok {
		t.Fatalf("second probe while in flight must be rejected")
	}
	// 记录结果后冷却期内仍必须被拒绝。
	RecordChannelProbe(channelID, model.ChannelProbeResult{OK: true, At: time.Now().UnixMilli(), KeysTotal: 1})
	if _, ok := TryBeginProbe(channelID); ok {
		t.Fatalf("probe within cooldown must be rejected")
	}
	// 主动释放占用后, 冷却未到仍拒绝(证明释放不会绕过冷却)。
	AbortProbe(channelID)
	if _, ok := TryBeginProbe(channelID); ok {
		t.Fatalf("probe within cooldown must still be rejected after abort")
	}
}
