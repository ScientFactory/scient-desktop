export const OVERLEAF_TOKEN_SITE = "www.overleaf.com";
export const OVERLEAF_TOKEN_SECRET = `overleaf-git-token-${Buffer.from(OVERLEAF_TOKEN_SITE, "utf8").toString("base64url")}`;
