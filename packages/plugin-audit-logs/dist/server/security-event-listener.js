var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var security_event_listener_exports = {};
__export(security_event_listener_exports, {
  registerSecurityEventListener: () => registerSecurityEventListener
});
module.exports = __toCommonJS(security_event_listener_exports);
var import_constants = require("./constants");
const REGISTERED_SYMBOL = Symbol.for("auditLogs:securityEventListenerRegistered");
function registerSecurityEventListener(plugin) {
  if (plugin.app[REGISTERED_SYMBOL]) {
    return;
  }
  plugin.app[REGISTERED_SYMBOL] = true;
  plugin.app.on(import_constants.EVENT_TENANT_SECURITY, async (event) => {
    var _a;
    try {
      const isImpersonation = event.type === "tenant_impersonation";
      const auditLogRepo = plugin.db.getRepository("auditLogs");
      await auditLogRepo.model.create({
        type: event.type,
        collectionName: event.collectionName || null,
        recordId: null,
        userId: event.userId ?? null,
        tenantId: event.tenantId ?? null,
        actorUserId: event.actorUserId ?? event.userId ?? null,
        impersonatedTenantId: isImpersonation ? event.impersonatedTenantId ?? ((_a = event.details) == null ? void 0 : _a.impersonatedTenantId) ?? event.tenantId ?? null : event.impersonatedTenantId ?? null,
        tenantContextSource: isImpersonation ? event.tenantContextSource ?? "platformImpersonation" : event.tenantContextSource ?? null,
        isTenantImpersonation: isImpersonation ? true : event.isTenantImpersonation ?? false,
        details: event.details || null
      });
    } catch {
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  registerSecurityEventListener
});
