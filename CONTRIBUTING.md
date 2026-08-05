# Contributing to OpenConfer

Thank you for contributing. By submitting a pull request, you agree to the Developer Certificate of Origin.

## Development

```bash
pnpm setup      # build + install openconfer to ~/.local/bin
pnpm dev        # run server and web UI with reload
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

If `openconfer` is not found after setup, add `export PATH="$HOME/.local/bin:$PATH"` to your shell config.

## Adapter contract tests

All adapters must implement the interfaces in `@openconfer/adapter-sdk` and pass contract tests.

## License

Apache 2.0
