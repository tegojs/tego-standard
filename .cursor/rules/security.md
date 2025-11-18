# Security Guidelines / 安全开发指南

This document provides comprehensive security guidelines for the Tego Standard project.

本文档提供 Tego Standard 项目的全面安全开发指南。

## Security Principles / 安全原则

1. **Defense in Depth / 纵深防御**
   - Multiple layers of security / 多层安全防护
   - Don't rely on a single security measure / 不要依赖单一安全措施

2. **Least Privilege / 最小权限**
   - Grant minimum necessary permissions / 授予最小必要权限
   - Principle of least privilege / 最小权限原则

3. **Secure by Default / 默认安全**
   - Secure configurations by default / 默认安全配置
   - Explicitly enable insecure features / 显式启用不安全功能

4. **Never Trust User Input / 永远不要信任用户输入**
   - Validate and sanitize all input / 验证和清理所有输入
   - Use parameterized queries / 使用参数化查询

## Authentication / 认证

### Token Security / Token 安全

```typescript
// ✅ Good / 好的 - Secure token handling / 安全的 token 处理
const token = ctx.getBearerToken();
if (!token) {
  ctx.throw(401, { message: 'Unauthenticated' });
}

// Validate token / 验证 token
const payload = await jwt.decode(token);
if (payload.exp < Date.now() / 1000) {
  ctx.throw(401, { message: 'Token expired' });
}

// Check blacklist / 检查黑名单
const blocked = await jwt.blacklist.has(payload.jti);
if (blocked) {
  ctx.throw(401, { message: 'Token blocked' });
}

// ❌ Bad / 不好的 - Trust token without validation / 不验证就信任 token
const token = ctx.getBearerToken();
const payload = jwt.decode(token); // No validation / 没有验证
```

### API Keys / API 密钥

```typescript
// ✅ Good / 好的 - Secure API key handling / 安全的 API 密钥处理
app.resourcer.use(async (ctx, next) => {
  const token = ctx.getBearerToken();
  if (token?.length === 64) { // API key format / API 密钥格式
    const key = await repo.findOne({
      filter: { accessToken: token },
    });
    if (key) {
      ctx.getBearerToken = () => key.token; // Use associated token / 使用关联的 token
    }
  }
  await next();
}, { tag: 'api-access-token', before: 'auth' });
```

### Password Security / 密码安全

```typescript
import bcrypt from 'bcrypt';

// ✅ Good / 好的 - Hash passwords / 哈希密码
const hashedPassword = await bcrypt.hash(password, 10);

// ✅ Good / 好的 - Verify passwords / 验证密码
const isValid = await bcrypt.compare(password, hashedPassword);

// ❌ Bad / 不好的 - Store plain text passwords / 存储明文密码
await db.getRepository('users').create({
  values: { password: plainTextPassword }, // Never do this / 永远不要这样做
});
```

## Authorization / 授权

### ACL (Access Control List) / 访问控制列表

```typescript
// ✅ Good / 好的 - Check permissions before actions / 操作前检查权限
const canAccess = await ctx.acl.can({
  role: ctx.state.user.role,
  resource: 'users',
  action: 'create',
});

if (!canAccess) {
  ctx.throw(403, { message: 'Forbidden' });
}

// ✅ Good / 好的 - Use ACL middleware / 使用 ACL 中间件
app.resourcer.use(acl.middleware(), { tag: 'acl', after: ['auth'] });
```

### Resource-Level Authorization / 资源级授权

```typescript
// ✅ Good / 好的 - Filter by user ownership / 按用户所有权过滤
app.resourcer.use(async (ctx, next) => {
  const { resourceName, actionName } = ctx.action;
  if (resourceName === 'apiKeys' && ['list', 'destroy'].includes(actionName)) {
    ctx.action.mergeParams({
      filter: {
        createdById: ctx.auth.user.id, // Only user's own resources / 仅用户自己的资源
      },
    });
  }
  await next();
}, { tag: 'resourceFilter', after: 'auth' });
```

### Module/Plugin Authorization / 模块/插件授权

```typescript
// ✅ Good / 好的 - Register ACL snippets for plugins / 为插件注册 ACL 片段
class MyPlugin extends Plugin {
  async beforeLoad() {
    this.app.acl.registerSnippet({
      name: ['pm', this.name, 'configuration'].join('.'),
      actions: ['myResource:list', 'myResource:create'],
    });
  }
}
```

## Input Validation / 输入验证

### Sanitize User Input / 清理用户输入

```typescript
import validator from 'validator';

// ✅ Good / 好的 - Validate and sanitize input / 验证和清理输入
function validateEmail(email: string): string {
  if (!validator.isEmail(email)) {
    throw new Error('Invalid email format');
  }
  return validator.normalizeEmail(email);
}

function sanitizeHtml(html: string): string {
  return validator.escape(html); // Prevent XSS / 防止 XSS
}

// ❌ Bad / 不好的 - Use raw user input / 使用原始用户输入
const userInput = ctx.request.body.content;
await db.getRepository('posts').create({ values: { content: userInput } }); // XSS risk / XSS 风险
```

### SQL Injection Prevention / SQL 注入防护

```typescript
// ✅ Good / 好的 - Use parameterized queries / 使用参数化查询
const user = await db.getRepository('users').findOne({
  filter: {
    email: userEmail, // Parameterized / 参数化
  },
});

// ❌ Bad / 不好的 - String concatenation / 字符串拼接
const query = `SELECT * FROM users WHERE email = '${userEmail}'`; // SQL injection risk / SQL 注入风险
```

### Type Validation / 类型验证

```typescript
import { z } from 'zod';

// ✅ Good / 好的 - Use schema validation / 使用模式验证
const userSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().min(0).max(120),
});

const validatedData = userSchema.parse(ctx.request.body);
```

## Data Protection / 数据保护

### Sensitive Data / 敏感数据

```typescript
// ✅ Good / 好的 - Don't expose sensitive fields / 不暴露敏感字段
const user = await db.getRepository('users').findOne({
  filter: { id: userId },
  appends: ['profile'],
});

// Remove sensitive data / 移除敏感数据
delete user.password;
delete user.secretKey;
delete user.apiKey;

// ❌ Bad / 不好的 - Expose all fields / 暴露所有字段
const user = await db.getRepository('users').findOne({ filter: { id: userId } });
ctx.body = user; // May include password / 可能包含密码
```

### Encryption / 加密

```typescript
import crypto from 'crypto';

// ✅ Good / 好的 - Encrypt sensitive data / 加密敏感数据
function encrypt(text: string): string {
  const algorithm = 'aes-256-gcm';
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return `${iv.toString('hex')}:${encrypted}`;
}
```

## API Security / API 安全

### Rate Limiting / 速率限制

```typescript
import rateLimit from 'express-rate-limit';

// ✅ Good / 好的 - Implement rate limiting / 实现速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes / 15 分钟
  max: 100, // Limit each IP to 100 requests per windowMs / 限制每个 IP 在窗口时间内最多 100 个请求
});

app.use('/api/', limiter);
```

### CORS Configuration / CORS 配置

```typescript
// ✅ Good / 好的 - Restrictive CORS / 限制性 CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://example.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ❌ Bad / 不好的 - Allow all origins / 允许所有来源
app.use(cors({ origin: '*' })); // Security risk / 安全风险
```

### HTTPS / HTTPS

```typescript
// ✅ Good / 好的 - Force HTTPS in production / 生产环境强制 HTTPS
if (process.env.NODE_ENV === 'production') {
  app.use((ctx, next) => {
    if (ctx.protocol !== 'https') {
      ctx.redirect(`https://${ctx.host}${ctx.url}`);
      return;
    }
    return next();
  });
}
```

## Common Vulnerabilities / 常见漏洞

### XSS (Cross-Site Scripting) / 跨站脚本攻击

```typescript
// ✅ Good / 好的 - Escape user input / 转义用户输入
import { escape } from 'lodash';

const safeContent = escape(userInput);

// ✅ Good / 好的 - Use Content Security Policy / 使用内容安全策略
app.use((ctx, next) => {
  ctx.set('Content-Security-Policy', "default-src 'self'");
  return next();
});
```

### CSRF (Cross-Site Request Forgery) / 跨站请求伪造

```typescript
// ✅ Good / 好的 - Use CSRF tokens / 使用 CSRF token
import csrf from 'csurf';

const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);

// Include token in forms / 在表单中包含 token
app.use((ctx, next) => {
  ctx.state.csrfToken = ctx.csrfToken();
  return next();
});
```

### Path Traversal / 路径遍历

```typescript
// ✅ Good / 好的 - Validate file paths / 验证文件路径
import path from 'path';

function getSafeFilePath(userPath: string): string {
  const normalized = path.normalize(userPath);
  const baseDir = '/safe/directory';
  
  if (!normalized.startsWith(baseDir)) {
    throw new Error('Invalid path');
  }
  
  return normalized;
}

// ❌ Bad / 不好的 - Use user input directly / 直接使用用户输入
const filePath = path.join('/uploads', userInput); // Path traversal risk / 路径遍历风险
```

## Security Headers / 安全头

```typescript
// ✅ Good / 好的 - Set security headers / 设置安全头
app.use(async (ctx, next) => {
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('X-Frame-Options', 'DENY');
  ctx.set('X-XSS-Protection', '1; mode=block');
  ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  ctx.set('Content-Security-Policy', "default-src 'self'");
  await next();
});
```

## Environment Variables / 环境变量

```typescript
// ✅ Good / 好的 - Use environment variables for secrets / 使用环境变量存储密钥
const config = {
  jwtSecret: process.env.JWT_SECRET, // Never hardcode / 永远不要硬编码
  dbPassword: process.env.DB_PASSWORD,
  apiKey: process.env.API_KEY,
};

// Validate required environment variables / 验证必需的环境变量
const requiredEnvVars = ['JWT_SECRET', 'DB_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
```

## Logging and Monitoring / 日志和监控

```typescript
// ✅ Good / 好的 - Log security events / 记录安全事件
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      ctx.logger.warn('Security event', {
        status: err.status,
        path: ctx.path,
        ip: ctx.ip,
        user: ctx.state.user?.id,
      });
    }
    throw err;
  }
});
```

## Module/Plugin Security / 模块/插件安全

### Secure Plugin Initialization / 安全的插件初始化

```typescript
// ✅ Good / 好的 - Validate plugin configuration / 验证插件配置
class MyPlugin extends Plugin {
  async beforeLoad() {
    // Validate required options / 验证必需的选项
    if (!this.options.apiKey) {
      throw new Error('API key is required');
    }
    
    // Register resources securely / 安全地注册资源
    this.app.resourcer.define({
      name: 'myResource',
      actions: {
        list: { handler: this.handleList },
      },
    });
  }
}
```

### Plugin Isolation / 插件隔离

```typescript
// ✅ Good / 好的 - Isolate plugin data / 隔离插件数据
class MyPlugin extends Plugin {
  async load() {
    // Use plugin-specific namespace / 使用插件特定的命名空间
    this.app.db.collection({
      name: `${this.name}_data`, // Namespace by plugin name / 按插件名称命名空间
      fields: [...],
    });
  }
}
```

## Checklist / 检查清单

### Authentication / 认证

- [ ] Use secure token storage / 使用安全的 token 存储
- [ ] Implement token expiration / 实现 token 过期
- [ ] Implement token blacklist / 实现 token 黑名单
- [ ] Hash passwords / 哈希密码
- [ ] Use strong password policies / 使用强密码策略
- [ ] Secure API key handling / 安全的 API 密钥处理

### Authorization / 授权

- [ ] Implement ACL / 实现 ACL
- [ ] Check permissions before actions / 操作前检查权限
- [ ] Filter resources by ownership / 按所有权过滤资源
- [ ] Use least privilege principle / 使用最小权限原则
- [ ] Register ACL snippets for plugins / 为插件注册 ACL 片段

### Input Validation / 输入验证

- [ ] Validate all user input / 验证所有用户输入
- [ ] Sanitize HTML content / 清理 HTML 内容
- [ ] Use parameterized queries / 使用参数化查询
- [ ] Validate file uploads / 验证文件上传

### Data Protection / 数据保护

- [ ] Don't expose sensitive fields / 不暴露敏感字段
- [ ] Encrypt sensitive data / 加密敏感数据
- [ ] Use HTTPS in production / 生产环境使用 HTTPS
- [ ] Secure environment variables / 保护环境变量

### API Security / API 安全

- [ ] Implement rate limiting / 实现速率限制
- [ ] Configure CORS properly / 正确配置 CORS
- [ ] Use security headers / 使用安全头
- [ ] Implement CSRF protection / 实现 CSRF 保护

### Module/Plugin Security / 模块/插件安全

- [ ] Validate plugin configuration / 验证插件配置
- [ ] Isolate plugin data / 隔离插件数据
- [ ] Secure plugin initialization / 安全的插件初始化

## Resources / 资源

- **OWASP Top 10**: https://owasp.org/www-project-top-ten/
- **Node.js Security Best Practices**: https://nodejs.org/en/docs/guides/security/
- **Express Security**: https://expressjs.com/en/advanced/best-practice-security.html

