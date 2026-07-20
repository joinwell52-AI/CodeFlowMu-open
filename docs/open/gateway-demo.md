# Gateway 策略

公开版默认连接官方演示 / 受限 Gateway；不连接私有 Gateway。

Gateway 在公开版里的定位是：

- 官方演示
- 有限制使用
- 官方 Gateway 服务端执行授权、频率、隐私和数据留存限制

默认配置文件：

```text
.codeflowmu/mobile-gateway.json
```

默认值为 `enabled: true`、`auto_connect: true`，并使用官方受限 Gateway 地址。

Gateway 未配置或不可用时，客户端显示明确状态并停止自动重连；不会无限循环重连。
