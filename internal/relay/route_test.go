package relay

import (
	"testing"
	"time"

	"github.com/bestruirui/octopus/internal/model"
)

// routeTestGroup 构造一个三成员的故障转移分组, 优先级即顺序。
func routeTestGroup(id int) model.Group {
	return model.Group{
		ID:          id,
		Mode:        model.GroupModeFailover,
		RelayConfig: model.DefaultGroupRelayConfig(),
		Items: []model.GroupItem{
			{ID: 1, Priority: 1},
			{ID: 2, Priority: 2},
			{ID: 3, Priority: 3},
		},
	}
}

// setRoute 预置分组的进程内路由状态并登记清理。
func setRoute(t *testing.T, groupID int, state RouteState) {
	t.Helper()
	ResetRouteState(groupID)
	t.Cleanup(func() { ResetRouteState(groupID) })
	routeMu.Lock()
	routes[groupID] = &state
	routeMu.Unlock()
}

// 本请求内已试过的成员即便冷却到期也不能被重新选中, 否则渠道多时首个成员会被反复调用。
func TestPickGroupItemSkipsTriedExpiredMember(t *testing.T) {
	g := routeTestGroup(910)
	now := time.Now().UnixMilli()
	setRoute(t, 910, RouteState{GroupID: 910, CurrentItemID: 2, Cooldowns: map[int]int64{1: now - 1000}})

	got := pickGroupItem(g, map[int]bool{1: true})
	if got.ID != 2 {
		t.Fatalf("expected sticky member 2 (skip tried 1), got %d", got.ID)
	}
}

// 未在本请求试过的到期成员仍可被探测恢复, 保留原有故障回切能力。
func TestPickGroupItemUntriedExpiredStillEligible(t *testing.T) {
	g := routeTestGroup(911)
	now := time.Now().UnixMilli()
	setRoute(t, 911, RouteState{GroupID: 911, CurrentItemID: 2, Cooldowns: map[int]int64{1: now - 1000}})

	got := pickGroupItem(g, map[int]bool{})
	if got.ID != 1 {
		t.Fatalf("expected failback to probe member 1, got %d", got.ID)
	}
}

// 已试过的是当前成员时, 不能停留, 应继续选下一个未试成员。
func TestPickGroupItemTriedCurrentAdvances(t *testing.T) {
	g := routeTestGroup(912)
	setRoute(t, 912, RouteState{GroupID: 912, CurrentItemID: 1, Cooldowns: map[int]int64{}})

	got := pickGroupItem(g, map[int]bool{1: true})
	if got.ID != 2 {
		t.Fatalf("expected advance to member 2, got %d", got.ID)
	}
}

// 所有成员都试过且无可用时返回零值, 由调用方决定重来或失败。
func TestPickGroupItemAllTriedReturnsZero(t *testing.T) {
	g := routeTestGroup(913)
	setRoute(t, 913, RouteState{GroupID: 913, CurrentItemID: 2, Cooldowns: map[int]int64{}})

	got := pickGroupItem(g, map[int]bool{1: true, 2: true, 3: true})
	if got.ID != 0 {
		t.Fatalf("expected zero when all tried, got %d", got.ID)
	}
}
