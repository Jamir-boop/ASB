# 百炼额度本地桥接

这个 Manifest V3 扩展复用 Chrome 里已经登录的阿里云百炼控制台，每 5 分钟读取一次 Token Plan 个人版的 7 天已用比例、重置时间、套餐名和到期时间，并发送到本机 `http://127.0.0.1:4629`。

它不会请求 `cookies` 权限，不读取或保存 Cookie、API Key、账号名、UID、订单或账单。扩展只从“套餐额度”和“订阅信息”两个最小页面区块生成脱敏 JSON；Agent Mission Control 还会再次校验字段白名单、比例和时间范围，再以 `0600` 权限写入 `~/.agent-mission-control/bailian-quota.json`。

## 本地安装

1. 保持 Agent Mission Control 在 `127.0.0.1:4629` 运行。
2. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录 `extensions/bailian-quota-bridge`。
4. 确保 Chrome 已登录阿里云百炼；无需一直打开额度页。

安装后会立即尝试刷新一次，以后每 5 分钟创建一个非活动额度页，读取成功或 1 分钟超时后自动关闭。点击扩展图标可以手动触发刷新。Chrome 完全退出时不会刷新，面板继续显示最后一次脱敏快照并标为缓存。

卸载扩展即可停止刷新；缓存文件可单独保留或手动删除。
