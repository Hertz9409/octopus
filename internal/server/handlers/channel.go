package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/bestruirui/octopus/internal/probe"
	"github.com/bestruirui/octopus/internal/server/middleware"
	"github.com/bestruirui/octopus/internal/server/resp"
	"github.com/bestruirui/octopus/internal/server/router"
	"github.com/dlclark/regexp2"
	"github.com/gin-gonic/gin"
)

func init() {
	router.NewGroupRouter("/api/v1/channel").
		Use(middleware.Auth()).
		Use(middleware.RequireJSON()).
		AddRoute(
			router.NewRoute("/detail/:id", http.MethodGet).
				Handle(getChannelDetail),
		).
		AddRoute(
			router.NewRoute("/stats", http.MethodGet).
				Handle(listChannelStats),
		).
		AddRoute(
			router.NewRoute("/grants", http.MethodGet).
				Handle(listChannelGrant),
		).
		AddRoute(
			router.NewRoute("/create", http.MethodPost).
				Handle(createChannel),
		).
		AddRoute(
			router.NewRoute("/update", http.MethodPost).
				Handle(updateChannel),
		).
		AddRoute(
			router.NewRoute("/enable", http.MethodPost).
				Handle(enableChannel),
		).
		AddRoute(
			router.NewRoute("/delete/:id", http.MethodDelete).
				Handle(deleteChannel),
		).
		AddRoute(
			router.NewRoute("/fetch-model", http.MethodPost).
				Handle(fetchModel),
		).
		AddRoute(
			router.NewRoute("/health/check", http.MethodPost).
				Handle(checkChannelHealth),
		)
}

// getChannelDetail 返回单个渠道的完整配置, 供编辑表单打开时读取。
// 与列表分开: 整份配置带着路径, 代理与凭据明文, 只有正在编辑的那一个渠道用得上。
func getChannelDetail(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidParam)
		return
	}
	detail, err := op.ChannelDetailGet(id)
	if err != nil {
		resp.Error(c, http.StatusNotFound, err.Error())
		return
	}
	resp.Success(c, detail)
}

// listChannelStats 返回全部渠道及其模型的累计统计, 也是渠道列表页的数据来源。
// 不带整份配置: 统计每次转发都在变, 界面按更短的间隔刷新它, 而路径, 代理与凭据明文只在编辑时用得上。
func listChannelStats(c *gin.Context) {
	resp.Success(c, op.ChannelStatsList())
}

// listChannelGrant 返回全部渠道授权候选, 供分组页选取成员。
func listChannelGrant(c *gin.Context) {
	resp.Success(c, op.ChannelGrantCandidates())
}

func createChannel(c *gin.Context) {
	var req model.ChannelDetail
	if err := c.ShouldBindJSON(&req); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	channel, err := op.ChannelCreate(&req, c.Request.Context())
	if err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Success(c, channel)
}

func updateChannel(c *gin.Context) {
	var req model.ChannelDetail
	if err := c.ShouldBindJSON(&req); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	if req.ID == 0 {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidParam)
		return
	}
	channel, err := op.ChannelUpdate(&req, c.Request.Context())
	if err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Success(c, channel)
}

func enableChannel(c *gin.Context) {
	var request struct {
		ID      int  `json:"id"`
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	if err := op.ChannelEnabled(request.ID, request.Enabled, c.Request.Context()); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Success(c, nil)
}

func deleteChannel(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidParam)
		return
	}
	if err := op.ChannelDel(id, c.Request.Context()); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Success(c, nil)
}

// fetchModel 按提交的渠道配置与凭据拉取上游模型列表, 并按过滤表达式筛选后返回。
// 两侧探测与协议位判定由 probe.ProbeModels 完成; 此处只负责校验入参并叠加渠道与全局过滤。
func fetchModel(c *gin.Context) {
	var request model.ChannelFetchModelRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	ctx := c.Request.Context()
	// 探测收的是尚未落库的提交配置, 不经 normalizeChannelConfig, 故在此自行去空白;
	// 其中只有地址是硬需求: 渠道尚未命名时也可试拉, 故名称不在此校验。
	target := request.Channel
	target.BaseURL = strings.TrimSpace(target.BaseURL)
	target.ChannelProxy = strings.TrimSpace(target.ChannelProxy)
	target.MatchRegex = strings.TrimSpace(target.MatchRegex)
	if target.BaseURL == "" {
		resp.Error(c, http.StatusBadRequest, "channel base url is required")
		return
	}

	client, closeClient, err := probe.Client(target)
	if err != nil {
		resp.Error(c, http.StatusBadGateway, err.Error())
		return
	}
	if closeClient != nil {
		defer closeClient()
	}

	models, err := probe.ProbeModels(ctx, client, target, request.Key)
	if err != nil {
		// 上游鉴权失败或地址不通属于调用方配置问题, 按 502 返回并带上上游原文, 便于在界面上直接看到原因。
		resp.Error(c, http.StatusBadGateway, err.Error())
		return
	}

	var re, reGlobal *regexp2.Regexp
	if target.MatchRegex != "" {
		if re, err = regexp2.Compile(target.MatchRegex, regexp2.ECMAScript); err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	}
	// 全局过滤由设置页维护, 与渠道过滤同取 AND: 模型须同时通过两枚正则才保留, 留空的一侧不生效。
	// 设置缺失按不过滤处理: 启动初始化会补齐默认值, 缺行只可能出现在旧库尚未刷新的瞬间。
	globalFilter, _ := op.SettingGetString(model.SettingKeyModelFilter)
	if globalFilter != "" {
		if reGlobal, err = regexp2.Compile(globalFilter, regexp2.ECMAScript); err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	}

	// 模型名须同时通过渠道与全局两枚过滤正则, 编译与匹配错误统一按请求错误返回。
	matches := func(name string) (bool, error) {
		if re != nil {
			matched, err := re.MatchString(name)
			if err != nil {
				return false, err
			}
			if !matched {
				return false, nil
			}
		}
		if reGlobal != nil {
			matched, err := reGlobal.MatchString(name)
			if err != nil {
				return false, err
			}
			if !matched {
				return false, nil
			}
		}
		return true, nil
	}

	// 保持 probe 给出的顺序(先 OpenAI 再 Anthropic), 只剔除未通过过滤的模型。
	filtered := make([]model.ChannelFetchModel, 0, len(models))
	for _, upstreamModel := range models {
		matched, err := matches(upstreamModel.Name)
		if err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		if matched {
			filtered = append(filtered, upstreamModel)
		}
	}
	resp.Success(c, filtered)
}

// checkChannelHealth 手动触发一次渠道连通性检测: 对渠道下每个启用且已填密钥的凭据打上游 /models。
// 只读、不消耗 token, 只证明地址可达与凭据有效, 不代表每个模型都能真正推理。
// 同一渠道两次检测至少间隔 60 秒, 并可在设置页用全局开关彻底关掉, 避免对上游形成测活压力。
func checkChannelHealth(c *gin.Context) {
	var request struct {
		ID int `json:"id"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || request.ID <= 0 {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidParam)
		return
	}
	if enabled, err := op.SettingGetBool(model.SettingKeyChannelProbeEnabled); err == nil && !enabled {
		resp.Error(c, http.StatusForbidden, "channel probe is disabled in settings")
		return
	}

	channel, err := op.ChannelGet(request.ID)
	if err != nil {
		resp.Error(c, http.StatusNotFound, err.Error())
		return
	}
	detail, err := op.ChannelDetailGet(request.ID)
	if err != nil {
		resp.Error(c, http.StatusNotFound, err.Error())
		return
	}

	keys := make([]model.ChannelKeyConfig, 0, len(detail.Keys))
	for _, channelKey := range detail.Keys {
		if channelKey.Enabled && strings.TrimSpace(channelKey.Key) != "" {
			keys = append(keys, channelKey)
		}
	}

	// 原子占用一次探测名额: 冷却未到或该渠道已有探测在途则拒绝, 避免并发请求同时通过检查各探一次。
	if remain, ok := op.TryBeginProbe(request.ID); !ok {
		resp.Error(c, http.StatusTooManyRequests, fmt.Sprintf("probe too frequent, retry after %d s", int(remain.Seconds()+0.5)))
		return
	}
	// 正常路径由 RecordChannelProbe 释放占用; 提前返回/异常时由 defer 归还名额。
	defer op.AbortProbe(request.ID)

	result := model.ChannelProbeResult{At: time.Now().UnixMilli()}
	if len(keys) == 0 {
		result.Error = "no enabled credential with a key"
	} else if client, closeClient, clientErr := probe.Client(detail.ChannelConfig); clientErr != nil {
		result.Error = clientErr.Error()
	} else {
		if closeClient != nil {
			defer closeClient()
		}
		// 探测整体设超时, 单个凭据再按并发上限控制, 避免凭据多时长时间挂住请求。
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()

		var (
			wg         sync.WaitGroup
			mu         sync.Mutex
			keysOK     int
			minLatency int64
			errs       []string
		)
		sem := make(chan struct{}, 4)
		for _, channelKey := range keys {
			wg.Add(1)
			sem <- struct{}{}
			go func(channelKey model.ChannelKeyConfig) {
				defer wg.Done()
				defer func() { <-sem }()
				start := time.Now()
				_, probeErr := probe.ProbeModels(ctx, client, detail.ChannelConfig, channelKey.Key)
				latency := time.Since(start).Milliseconds()
				mu.Lock()
				defer mu.Unlock()
				if probeErr != nil {
					errs = append(errs, fmt.Sprintf("%s: %v", channelKey.Name, probeErr))
					return
				}
				keysOK++
				if minLatency == 0 || latency < minLatency {
					minLatency = latency
				}
			}(channelKey)
		}
		wg.Wait()

		result.KeysTotal = len(keys)
		result.KeysOK = keysOK
		result.LatencyMS = minLatency
		result.OK = keysOK > 0
		if !result.OK {
			result.Error = strings.Join(errs, "; ")
		}
	}

	op.RecordChannelProbe(request.ID, result)
	resp.Success(c, op.ChannelHealthSnapshot(request.ID, channel.Enabled))
}
