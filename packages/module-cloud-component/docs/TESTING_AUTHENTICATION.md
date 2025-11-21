# 测试认证功能 / Testing Authentication

## 使用 curl 测试认证

### 测试 Bearer Token

```bash
# 替换以下变量：
# - YOUR_URL: 你的 Git 服务器 URL
# - YOUR_TOKEN: 你的 Bearer Token

curl -H "Authorization: Bearer YOUR_TOKEN" \
     -H "User-Agent: TegoCloudComponent/1.0" \
     "YOUR_URL"
```

**示例：**
```bash
curl -H "Authorization: Bearer glpat-xxxxxxxxxxxxxxxxxxxx" \
     -H "User-Agent: TegoCloudComponent/1.0" \
     "https://git.daoyoucloud.com/daoyoucloud/hera-rental/src/branch/main/src/add-check.tsx"
```

### 测试 Basic Auth

```bash
# 替换以下变量：
# - YOUR_URL: 你的 Git 服务器 URL
# - YOUR_USERNAME: 你的用户名
# - YOUR_PASSWORD: 你的密码

curl -u "YOUR_USERNAME:YOUR_PASSWORD" \
     -H "User-Agent: TegoCloudComponent/1.0" \
     "YOUR_URL"
```

**示例：**
```bash
curl -u "username:password" \
     -H "User-Agent: TegoCloudComponent/1.0" \
     "https://git.daoyoucloud.com/daoyoucloud/hera-rental/src/branch/main/src/add-check.tsx"
```

### 测试无认证（对比）

```bash
# 不添加认证头，测试是否会返回 401/403
curl -H "User-Agent: TegoCloudComponent/1.0" \
     "YOUR_URL"
```

## 检查服务器日志

在服务器日志中查找以下信息：

1. **认证类型确认**：
   ```
   Fetching from URL: https://... (with token auth)
   Using Bearer Token authentication (token length: XX)
   ```

2. **请求头信息**（调试模式）：
   ```
   Request headers: {"User-Agent":"TegoCloudComponent/1.0","Authorization":"Bearer xxxx..."}
   ```

3. **错误信息**：
   - `HTTP 401`: 认证失败（token 无效或过期）
   - `HTTP 403`: 权限不足（token 有效但无访问权限）
   - `HTTP 404`: URL 不存在或路径错误

## 常见问题排查

### 1. Token 格式问题

确保 token 格式正确：
- **Bearer Token**: 不应该包含 "Bearer " 前缀，系统会自动添加
- **Basic Auth**: 用户名和密码都不应该包含特殊字符，如果有需要 URL 编码

### 2. Token 权限问题

检查 token 是否有以下权限：
- 读取仓库内容
- 访问 raw 文件
- 访问指定分支

### 3. URL 格式问题

确保 URL 格式正确：
- 对于 GitLab 风格的服务器，URL 应该是 raw 文件 URL
- 格式：`https://host/owner/repo/src/branch/branch-name/path/to/file.tsx`
- 或：`https://host/owner/repo/-/raw/branch-name/path/to/file.tsx`

### 4. 检查实际发送的请求

在代码中添加临时日志，查看实际发送的请求：

```typescript
// 在 remote-code-fetcher.ts 的 fetchFromCDN 方法中
console.log('Actual request:', {
  url,
  headers: {
    ...headers,
    Authorization: headers.Authorization ? '[REDACTED]' : undefined
  }
});
```

## 使用浏览器开发者工具测试

1. 打开浏览器开发者工具（F12）
2. 切换到 Network 标签
3. 在前端点击"同步远程代码"按钮
4. 查看发送的请求：
   - 检查请求 URL
   - 检查请求头中的 `Authorization` 字段
   - 查看响应状态码和错误信息

## 使用 Postman 或类似工具测试

1. 创建新请求
2. 设置请求方法为 GET
3. 输入 URL
4. 在 Headers 中添加：
   - `Authorization: Bearer YOUR_TOKEN` (Bearer Token)
   - 或使用 Basic Auth 标签页输入用户名和密码
5. 发送请求并查看响应

