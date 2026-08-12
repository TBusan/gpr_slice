#pragma once

// 极简并行工具：把 [0, n) 范围的任务分发到 count 个线程。
// 仅用 std::thread（无新依赖）。fn(idx) 必须线程安全（各任务相互独立）。

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

namespace gvt {

// 返回失败任务个数（fn 返回 false 计一次失败）。
inline int RunParallel(int64_t n, int count, const std::function<bool(int64_t)>& fn) {
    if (n <= 0) return 0;
    if (count < 1) count = 1;

    std::atomic<int64_t> next{0};
    std::atomic<int> failures{0};

    auto worker = [&]() {
        for (;;) {
            const int64_t i = next.fetch_add(1);
            if (i >= n) break;
            if (!fn(i)) failures.fetch_add(1);
        }
    };

    std::vector<std::thread> threads;
    threads.reserve((size_t)count);
    for (int w = 0; w < count; ++w) threads.emplace_back(worker);
    for (auto& t : threads) t.join();

    return failures.load();
}

} // namespace gvt
