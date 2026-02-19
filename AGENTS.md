# AGENTS.md

> Instructions for AI coding agents working in this repository.
> Project: autocontext

<!-- autocontext:agents-section -->
## Project Context

This project uses [autocontext](https://github.com/salehsquared/autocontext) for structured codebase documentation.

**Every directory with source files contains a `.context.yaml` file.** It describes:

- What the directory contains and its purpose (summary)
- Architectural decisions and constraints (things you can't infer from code)
- Subdirectory routing (what's inside each subdirectory)

### How to Use Context Files

1. **Before exploring a directory**, read its `.context.yaml` summary to understand what it does
2. **Before modifying code**, check `decisions` and `constraints` for rationale and hard rules
3. **After modifying files**, update the summary if the directory's purpose changed
4. **To check freshness**, run `context status` — stale contexts may have outdated information

### Directory Index

| Directory | Summary |
|-----------|---------|
| `.` (root) | This directory serves as the project root for autocontext, which manages folder-level documentation for LLMs through structured \`.context.yaml\` files in each directory. It provides essential context about the project structure, architectural decisions, and required constraints for developers and AI tools.  |
| `docs` | This directory contains documentation for using and integrating autocontext within projects, including CI/CD pipeline implementations, integration setups, and user guides. It provides essential guidelines for maintaining context quality and leveraging the MCP server functionalities.  |
| `scripts` | The 'scripts' directory contains utility scripts for managing project workflows, including building grammar files, generating schemas, and configuring git hooks. These scripts automate essential tasks to ensure smooth development and maintenance of the project.  |
| `src` | The \`src\` directory is responsible for implementing the core functionalities and command-line interface for managing context generation and diagnostics in a project. It provides various commands for initializing configurations, validating context files, and monitoring their freshness.  |
| `src/bench` | The \`src/bench\` directory provides a framework for benchmarking the performance of AI models using structured tasks. It includes the setup for cloning repositories, generating tasks based on code structure, and scoring the results of model responses.  |
| `src/commands` | The \`src/commands\` directory contains various command implementations for managing context generation, configuration, and diagnostics for a project. Each file provides a specific functionality such as initializing configurations, running benchmarks, validating context files, and monitoring their freshness.  |
| `src/core` | The \`src/core\` directory contains core functionalities for computing file fingerprints, managing markdown files related to agents, and scanning project directories for context files. It serves as the backbone for context management within the project.  |
| `src/generator` | The \`src/generator\` directory contains code for generating structured documentation and managing code analysis tasks, including AST parsing for exports and dependency detection. It facilitates the generation of context files based on various programming languages and gathers evidence from existing artifacts for documentation purposes.  |
| `src/mcp` | The \`src/mcp\` directory implements the Model Context Protocol (MCP) server functionality, providing tools for managing and querying context information in a structured manner. It facilitates the registration of tools that allow interactions with \`.context.yaml\` files throughout a project structure.  |
| `src/providers` | This directory contains implementations of different LLM (Large Language Model) providers that adhere to a common interface. Each provider class is responsible for generating responses from its respective model using either SDKs or direct API calls.  |
| `src/utils` | The src/utils directory provides utility functions for managing configuration, environment variables, and processing tasks with bounded concurrency. It contains functionalities for loading and saving configurations, handling environment variables, and displaying messages. Additionally, it includes methods for token estimation and filtering.  |
| `tests` | The tests directory contains unit tests for various components of the project, ensuring functionality and correctness of features including command handling, generator processes, and utility functions. It uses the Vitest framework for structured testing across different modules.  |
| `tests/bench` | The tests/bench directory contains unit tests that evaluate the functionality and performance of the components in the bench module. It ensures that features related to git operations, task generation, scoring, and prompt building work as intended and meet specified requirements.  |
| `tests/commands` | This directory contains test cases for various command functionalities, ensuring the accuracy and reliability of commands related to configuration, initialization, status checking, and regeneration within the project. It encompasses unit tests using Vitest to validate individual command behaviors in isolation.  |
| `tests/core` | This directory contains unit tests for the core functionality of the markdown writer. It focuses on reading, writing, and updating agent-related markdown files, ensuring proper handling of file operations and content management.  |
| `tests/fixtures` | The tests/fixtures directory provides test fixtures for various scenarios, including a monorepo setup, a simple TypeScript project, and files designated to be ignored during testing. It serves to facilitate organized testing across different project configurations.  |
| `tests/fixtures/monorepo` | This directory contains the configuration for a monorepo setup, supporting multiple packages under a single workspace. It allows for organized development and shared components across the entire monorepo.  |
| `tests/fixtures/monorepo/packages` | This directory contains the packages of a monorepo, including the API package and shared type definitions. It serves to encapsulate the API functionality and provide consistent typing across various components of the monorepo.  |
| `tests/fixtures/monorepo/packages/api` | This directory contains the API package of the monorepo, providing the source code necessary for the API server implementation. It handles incoming requests and manages server startup on a designated port.  |
| `tests/fixtures/monorepo/packages/api/src` | This directory contains the source code for the API server implementation of the monorepo. It is responsible for handling incoming requests and starting the server on a specified port.  |
| `tests/fixtures/monorepo/packages/shared` | This directory hosts shared type definitions for a monorepo, ensuring consistent structure and typing across multiple packages. It standardizes configuration interfaces to facilitate better collaboration and maintainability.  |
| `tests/fixtures/monorepo/packages/shared/src` | This directory contains shared type definitions used across multiple packages in a monorepo setup. It standardizes configuration interfaces to ensure consistent structure and typing throughout the project.  |
| `tests/fixtures/simple-project` | This directory contains a basic TypeScript project setup, including source files and configuration for building the project. It serves as a template for understanding TypeScript module structure and compilation options.  |
| `tests/fixtures/simple-project/src` | This directory contains the source code for a simple TypeScript project, including utility functions and an entry point. It serves as a demonstration of basic TypeScript functionality and structure.  |
| `tests/fixtures/with-contextignore` | This directory contains test fixtures used in the testing process. It includes source files that may be ignored to streamline testing efforts.  |
| `tests/fixtures/with-contextignore/src` | This directory contains test fixtures utilized during the testing process. It specifically includes source files that may be ignored in context to focus testing efforts more effectively.  |
| `tests/generator` | This directory contains unit tests for the markdown generation functionality used in the project. It validates the correctness of various methods that handle the creation and manipulation of markdown content related to agents and their actions.  |
| `tests/mcp` | This directory contains tests for the Model Context Protocol (MCP) server and tools, ensuring proper functionality and behavior through various unit tests. It verifies server startup, tools registration, context handling, and transport connections.  |
| `tests/utils` | This directory contains unit tests for utility functions in the codebase, ensuring correctness and performance of functionalities such as pool processing and token estimation. It leverages the Vitest framework for running asynchronous tests with various scenarios.  |

### Maintenance

When you significantly change files in a directory, update its `.context.yaml`:
- Update `summary` if the directory's purpose shifted
- Update `decisions` if architectural choices changed
- Update `constraints` if hard rules changed

The `maintenance` field in each `.context.yaml` contains specific instructions.
<!-- autocontext:agents-section-end -->
