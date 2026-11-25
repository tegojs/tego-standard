import { Context, Next } from '@tego/server';

import { SAML } from '@node-saml/node-saml';

import { SAMLAuth } from '../saml-auth';

export const metadata = async (ctx: Context, next: Next) => {
  const auth = ctx.auth as SAMLAuth;
  const options = auth.getOptions();
  const saml = new SAML(options);

  ctx.type = 'text/xml';
  // The configured certificate validates the IdP and is not an SP decryption certificate.
  ctx.body = saml.generateServiceProviderMetadata(null);
  ctx.withoutDataWrapping = true;

  return next();
};
