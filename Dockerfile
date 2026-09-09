FROM grafana/k6:latest
WORKDIR /app
COPY src ./src
COPY examples ./examples
# Working directory for logs, schema and reports: mount it from the host.
WORKDIR /work
ENV LOG=/work/access.log \
    DEBUG_SCHEMA=/work/debug-schema.json \
    SUMMARY_JSON=/work/summary.json
ENTRYPOINT ["k6", "run"]
CMD ["/app/src/replay.ts"]
