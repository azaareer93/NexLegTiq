# Backup tools (D-141): the PostgreSQL 17 client (pg_dump/pg_restore, same major as the server), age (encryption) and
# rclone (any S3-compatible storage, two providers in one command). Built by .github/workflows/backup.yml and the local
# drill (scripts/backup-drill.sh); never pushed to a registry.
FROM postgres:17.6-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends age rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore-check.sh documents-copy.sh verify.sql /opt/backup/
RUN chmod 0555 /opt/backup/*.sh
# rclone is configured from RCLONE_CONFIG_<REMOTE>_* variables only.
ENV RCLONE_CONFIG=/dev/null
USER postgres
ENTRYPOINT ["/bin/bash"]
