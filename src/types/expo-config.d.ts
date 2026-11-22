// The root typecheck also compiles mobile/app.config.ts (the store-config test imports it), but Expo is only installed under mobile/.
// A loose stand-in keeps the root typecheck independent of mobile/node_modules; mobile's own tsconfig uses the real types.
declare module "expo/config" {
  export type ExpoConfig = { [key: string]: any };
}
