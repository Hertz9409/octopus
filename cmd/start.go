package cmd

import (
	"fmt"

	"github.com/bestruirui/octopus/internal/conf"
	"github.com/bestruirui/octopus/internal/db"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/bestruirui/octopus/internal/server"
	"github.com/bestruirui/octopus/internal/task"
	"github.com/bestruirui/octopus/internal/utils/shutdown"
	"github.com/charmbracelet/log"
	"github.com/spf13/cobra"
)

var cfgFile string

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start " + conf.APP_NAME,
	PreRunE: func(cmd *cobra.Command, args []string) error {
		conf.PrintBanner()
		// 配置文件读错时不能静默退回默认值, 否则改错一个字符就会换个端口启动。
		if err := conf.Load(cfgFile); err != nil {
			return err
		}
		if level, err := log.ParseLevel(conf.AppConfig.Log.Level); err == nil {
			log.SetLevel(level)
		}
		return nil
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		shutdown.Init(log.Default())
		if err := db.InitDB(conf.AppConfig.Database.Type, conf.AppConfig.Database.Path, conf.IsDebug()); err != nil {
			return fmt.Errorf("database init error: %w", err)
		}
		shutdown.Register(db.Close)

		if err := op.InitCache(); err != nil {
			return fmt.Errorf("cache init error: %w", err)
		}
		shutdown.Register(op.SaveCache)

		if err := op.AuthSecretInit(); err != nil {
			return fmt.Errorf("auth secret init error: %w", err)
		}

		if err := op.UserInit(); err != nil {
			return fmt.Errorf("user init error: %w", err)
		}

		if err := server.Start(); err != nil {
			return fmt.Errorf("server start error: %w", err)
		}
		shutdown.Register(server.Close)

		task.Init()
		go task.RUN()

		// 收到信号后先停 HTTP 监听并等待在途请求收尾, 再执行其余清理(关闭顺序为注册的逆序)。
		shutdown.Register(server.Shutdown)
		shutdown.Listen()
		return nil
	},
}

func init() {
	startCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is ./data/config.json)")
	rootCmd.AddCommand(startCmd)
}
