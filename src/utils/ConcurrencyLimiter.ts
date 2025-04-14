export default class ReentrantConcurrencyLimiter {
    readonly maxConcurrency: number;
    private current: number = 0;
    private queue: Array<() => void> = [];
    private executionContexts = new Map<unknown, number>(); // 跟踪执行上下文及其嵌套深度

    constructor(maxConcurrency: number) {
        if (maxConcurrency <= 0) {
            throw new Error("maxConcurrency must be positive");
        }
        this.maxConcurrency = maxConcurrency;
    }

    private getContextId(): unknown {
        // 使用Error堆栈生成唯一上下文ID（适用于同步/异步嵌套）
        try {
            throw new Error();
        } catch (e: any) {
            return e.stack;
        }
    }

    async acquire(): Promise<void> {
        const contextId = this.getContextId();
        const depth = this.executionContexts.get(contextId) || 0;

        if (depth > 0) {
            // 嵌套调用，不占用新槽位
            this.executionContexts.set(contextId, depth + 1);
            return;
        }

        if (this.current < this.maxConcurrency) {
            this.current++;
            this.executionContexts.set(contextId, 1);
            return;
        }

        return new Promise((resolve) => {
            this.queue.push(() => {
                this.current++;
                this.executionContexts.set(contextId, 1);
                resolve();
            });
        });
    }

    release(): void {
        const contextId = this.getContextId();
        const depth = this.executionContexts.get(contextId);

        if (!depth) {
            throw new Error("release() called without acquire()");
        }

        if (depth > 1) {
            // 嵌套调用退出，减少深度
            this.executionContexts.set(contextId, depth - 1);
            return;
        }

        // 最外层调用结束
        this.executionContexts.delete(contextId);
        this.current--;

        const next = this.queue.shift();
        if (next) {
            Promise.resolve().then(next); // 异步触发下一个任务
        }
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }
}