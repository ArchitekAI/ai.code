---
name: daytona-images-storage
displayName: Daytona Images and Storage
description: Build reproducible Daytona environments with declarative images, Dockerfiles, snapshots, and volumes. Use when optimizing sandbox startup, preinstalling dependencies, or persisting state across sandbox runs.
version: 1.0.0
author: Daytona
tags: [daytona, images, builder, snapshots, volumes, persistence]
---

# Daytona Images and Storage

Use this skill when the problem is reproducibility, startup speed, or persistence rather than one-off sandbox execution.

## Documentation Sources

- Declarative Builder: https://www.daytona.io/docs/en/declarative-builder.md
- Snapshots: https://www.daytona.io/docs/en/snapshots.md
- Volumes: https://www.daytona.io/docs/en/volumes.md
- Getting Started sandbox examples: https://www.daytona.io/docs/en/getting-started.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Choose the Right Primitive

- Use declarative images when the environment should be reproducible from source-controlled configuration.
- Use Dockerfile integration when an existing container workflow already exists or the environment is highly customized.
- Use snapshots when you want fast restore points of a known-good sandbox state.
- Use volumes when data must survive across multiple sandbox lifecycles independently of the image.

## Guidance

- Keep base images minimal and install only what the workflow truly needs.
- Treat snapshots as a speed and reproducibility tool, not a substitute for a documented build process.
- Prefer declarative image definitions for agent platforms that will create many similar sandboxes.
- Use volumes for caches, large datasets, or user-owned persistent files that should not be baked into images.
- Decide early whether persistence belongs in the image, the snapshot, or the volume so the lifecycle stays understandable.

## Common Patterns

- Fast-start coding agent: declarative image plus optional snapshot for warm environments.
- Reusable dataset sandbox: image for tools, volume for data, snapshot for precomputed state if startup latency matters.
- Controlled production workflow: image in source control, snapshots for rollback points, volumes only when persistence is truly required.
