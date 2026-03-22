# MCP Connector Plugin

Connect OpenClaw to external MCP (Model Context Protocol) servers.

*可以让OpenClaw连接外部MCP服务器。已测试支持版本OpenClaw v2026.3.13，其它版本未做测试。*

## 安装

1. 将此插件复制到你的 OpenClaw 扩展目录：
```bash
cp -r mcp-connector ~/.openclaw/extensions/
```

2. 重命名配置示例文件：
```bash
cd ~/.openclaw/extensions/mcp-connector
cp mcp-servers.json.example ~/.openclaw/mcp-servers.json
```

3. 编辑 `mcp-servers.json` 配置你的 MCP 服务器

## 配置

### HTTP 类型 (streamable-http)

```json
{
  "name": "my-server",
  "type": "streamable-http",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer your-token"
  }
}
```

### STDIO 类型 (本地进程)

```json
{
  "name": "filesystem",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"],
  "env": {
    "KEY": "value"
  }
}
```

## 可用工具

- `mcp_list_servers` - 列出所有已连接的 MCP 服务器
- `mcp_<server_name>_list_tools` - 列出某个 MCP 服务器上可用的工具
- `mcp_<server_name>_call` - 调用某个 MCP 服务器上的工具

## 使用示例

```javascript
// 1. 先列出可用的 MCP 服务器
mcp_list_servers

// 2. 查看某个服务器上有哪些工具
mcp_devops_list_tools

// 3. 调用某个工具
mcp_devops_call(tool="deploy", args={environment: "production"})
```

## 重启 OpenClaw

记得修改 OpenClaw 的配置文件（ openclaw.json ），把插件添加到 `plugins.allow` 中。

配置完成后，需要重启 Gateway 使插件生效：

```bash
openclaw gateway restart
```