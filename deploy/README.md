# Deployment

The deployment tools support Linux hosts using nginx and systemd.
Store host-specific settings in an ignored `.env` file.

## Configuration

Use [.env.example](../.env.example) as a reference. Set the SSH target, application
and media directories, service environment file, and rollback directory for your
installation. Point the `visualizer` and `tv` targets at the same host or separate hosts.

Configure media endpoints in the service environment as described in the
[README](../README.md#media-endpoints). Keep credentials and runtime data outside
the public web root. Protect operator access with authentication and HTTPS.

## Deploy code

Commit the release, then inspect the deployment plan:

```bash
npm run deploy-code -- visualizer
```

This validates the release and contacts the configured host to show the proposed
file changes. To apply the release:

```bash
npm run deploy-code -- visualizer --apply
```

The script saves a code rollback and a verified database snapshot before updating.
Code rollback preserves the current database. Restore data and transfer media
separately from code deployments.

## Installation tools

- [bootstrap.sh](bootstrap.sh) provisions a new system-service installation.
- [nginx.conf](nginx.conf) and the service templates describe the runtime configuration.
- [install-runtime-config.mjs](install-runtime-config.mjs) installs those templates.

Configure the installation paths before running these tools. Install web-server
and service configuration changes separately from code deployments.
