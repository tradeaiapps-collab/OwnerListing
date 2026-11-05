export function pageCsp(dev?: boolean): string;
export const baseSecurityHeaders: { key: string; value: string }[];
export function securityHeaderRules(dev?: boolean): { source: string; headers: { key: string; value: string }[] }[];
declare const config: { distDir: string; headers(): Promise<ReturnType<typeof securityHeaderRules>> };
export default config;
