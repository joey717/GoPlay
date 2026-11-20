#!/usr/bin/env python3
"""FlyAI POI 搜索耗时测量脚本（Task #277）"""
import subprocess, json, time
from urllib.parse import quote

queries = ['蜈支洲岛', '亚龙湾', '南山文化旅游区', '天涯海角', '呀诺达']
results = []
server_latencies = []

print('=== FlyAI POI 搜索测量（5次，destination=三亚） ===')
for i, q in enumerate(queries):
    url = f'http://localhost:8787/api/flyai/search?type=poi&q={quote(q)}&destination={quote("三亚")}'
    start = time.time()
    result = subprocess.run(['curl', '-s', url], capture_output=True, text=True)
    elapsed = time.time() - start
    try:
        data = json.loads(result.stdout)
        count = len(data.get('normalized', []))
        latency_server = data.get('latencyMs', 0)
        print(f'[{i+1}] q="{q}" -> e2e={elapsed:.2f}s server={latency_server}ms results={count}')
        server_latencies.append(latency_server)
    except Exception as e:
        print(f'[{i+1}] q="{q}" -> {elapsed:.2f}s (parse error: {e}, body={result.stdout[:200]})')
        server_latencies.append(0)
    results.append(elapsed)
    time.sleep(3)  # 避免限流

results.sort()
server_latencies.sort()
print(f'\n--- 端到端统计（含网络） ---')
print(f'p50 (中位): {results[2]:.2f}s')
print(f'最坏: {results[-1]:.2f}s')
print(f'最好: {results[0]:.2f}s')
print(f'全部: {[round(r,2) for r in results]}')
print(f'\n--- 服务端 latencyMs 统计 ---')
print(f'p50: {server_latencies[2]}ms')
print(f'最坏: {server_latencies[-1]}ms')
print(f'全部: {server_latencies}')
