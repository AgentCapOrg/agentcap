// A directory publish would resolve unbundled dependencies and lose root-only
// security overrides. Publish the verified, staged runtime tarball instead.
console.error(
  "[agentcap] Direct npm pack/publish is disabled. Run `npm run pack:release`, " +
  "verify the resulting package, then `npm publish ./release/agentcap-<version>.tgz`. " +
  "The release command builds the SDK and dashboard and bundles patched runtime dependencies.",
);
process.exitCode = 1;
