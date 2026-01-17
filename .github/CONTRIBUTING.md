# Contributing to Kanbn GitHub Sync (KGS)

Contributions are welcome! Whether you're fixing bugs, adding features, improving documentation, or sharing ideas, your help makes KGS better for everyone.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:
- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Your configuration (redact sensitive info like API keys)
- Logs/error messages if applicable

### Suggesting Features

Feature suggestions are welcome! Open an issue and describe:
- The feature you'd like to see
- Why it would be useful
- How it might work

### Code Contributions

1. **Fork the repository**
2. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** following the existing code style
4. **Test your changes**:
   ```bash
   yarn install
   yarn lint
   yarn type-check
   yarn start  # Test locally if possible
   ```
5. **Commit your changes** with clear commit messages
6. **Push and open a Pull Request**

### Code Style

- Use TypeScript for type safety
- Follow existing code patterns
- Run `yarn lint` before committing
- Ensure `yarn type-check` passes

### Documentation

Improvements to documentation are always appreciated! Whether it's:
- Fixing typos
- Clarifying instructions
- Adding examples
- Improving structure

Just open a PR with your changes.

## Questions?

Feel free to open an issue if you have questions about contributing or need help getting started.

Thanks for helping make KGS better! 🎉
