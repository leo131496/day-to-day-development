FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/
COPY static /app/static
COPY seed /app/seed
ENV PYTHONDONTWRITEBYTECODE=1 BOARD_HOST=0.0.0.0 BOARD_DATA_DIR=/data PORT=8765
RUN useradd --uid 10001 --create-home board && mkdir /data && chown board:board /data
USER board
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=2)"
CMD ["python", "-B", "server.py"]
