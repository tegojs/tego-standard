# oidc

English | [中文](./README.zh-CN.md)

## 安装激活

```bash
yarn pm enable oidc
```

## 使用方法

### Email verification

For a first-time identity, linking by email or saving an email during automatic signup requires the provider's original UserInfo response to contain the same `email` and the boolean claim `email_verified: true`. Missing, false, and non-boolean verification claims are rejected. Field mapping cannot supply verification or apply it to a different email address.

Existing subject bindings continue to work without rechecking email verification. Identities without an email can still sign up when automatic signup is enabled.
