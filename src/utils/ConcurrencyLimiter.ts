export default class ReentrantConcurrencyLimiter {
    readonly maxConcurrency: number;
    private current: number = 0;
    private queue: Array<() => void> = [];
    private executionContext = new WeakMap<object, number>();

    constructor(maxConcurrency: number) {
        if (maxConcurrency <= 0) throw new Error("maxConcurrency must be positive");
        this.maxConcurrency = maxConcurrency;
    }

    private getContextId(): object {
        return {}; // 每次调用生成唯一对象引用
    }

    async acquire(): Promise<void> {
        const contextId = this.getContextId();
        const depth = this.executionContext.get(contextId) || 0;

        if (depth > 0) {
            this.executionContext.set(contextId, depth + 1);
            return;
        }

        if (this.current < this.maxConcurrency) {
            this.current++;
            this.executionContext.set(contextId, 1);
            return;
        }

        return new Promise((resolve) => {
            this.queue.push(() => {
                this.current++;
                this.executionContext.set(contextId, 1);
                resolve();
            });
        });
    }

    release(): void {
        const contextId = this.getContextId();
        const depth = this.executionContext.get(contextId);

        if (depth === undefined) {
            throw new Error("release() called without acquire()");
        }

        if (depth > 1) {
            this.executionContext.set(contextId, depth - 1);
            return;
        }

        this.executionContext.delete(contextId);
        this.current--;

        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            // 仍异步执行，但需确保顺序
            Promise.resolve().then(next);
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