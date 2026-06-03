```markdown
# mission-control Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `mission-control` TypeScript codebase. You'll learn how to structure files, write imports/exports, follow commit conventions, and write tests in alignment with the project's standards. This guide is ideal for new contributors or anyone aiming to maintain consistency in the repository.

## Coding Conventions

### File Naming
- Use **kebab-case** for all file names.
  - **Example:**  
    ```
    user-profile.ts
    mission-control-utils.ts
    ```

### Import Style
- Use **alias imports** to reference modules.
  - **Example:**
    ```typescript
    import { UserService } from '@/services/user-service';
    ```

### Export Style
- Use **named exports** for all modules.
  - **Example:**
    ```typescript
    // In user-profile.ts
    export function getUserProfile(id: string) { ... }

    // Importing elsewhere
    import { getUserProfile } from '@/user-profile';
    ```

### Commit Messages
- Follow the **conventional commit** style.
- Use the `fix` prefix for bug fixes.
- Keep commit messages concise (average ~71 characters).
  - **Example:**
    ```
    fix: resolve issue with mission status update on retry
    ```

## Workflows

_No automated workflows detected in this repository._

## Testing Patterns

- Test files use the pattern `*.test.*` (e.g., `mission-control.test.ts`).
- The specific testing framework is not detected, but tests are colocated with source files or in dedicated test files.
- **Example:**
  ```typescript
  // mission-control.test.ts
  import { getMissionStatus } from '@/mission-control';

  test('should return correct status', () => {
    expect(getMissionStatus('123')).toBe('active');
  });
  ```

## Commands

| Command | Purpose |
|---------|---------|
| /conventions | Display coding conventions summary |
| /test-patterns | Show how to write and locate tests |
| /commit-style | Show commit message guidelines |
```
