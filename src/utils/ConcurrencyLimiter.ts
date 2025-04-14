export default class ReentrantConcurrencyLimiter {
    readonly maxConcurrency: number;
    private current: number = 0;
    private queue: Array<() => void> = [];
    private executionStack: Array<{ contextId: symbol; depth: number }> = [];

    constructor(maxConcurrency: number) {
        if (maxConcurrency <= 0) {
            throw new Error("maxConcurrency must be positive");
        }
        this.maxConcurrency = maxConcurrency;
    }

    private getContextId(): symbol {
        return Symbol('context');
    }

    async acquire(): Promise<void> {
        const contextId = this.getContextId();
        const existingContext = this.executionStack.find(c => c.contextId === contextId);

        if (existingContext) {
            existingContext.depth++;
            return;
        }

        if (this.current < this.maxConcurrency) {
            this.current++;
            this.executionStack.push({contextId, depth: 1});
            return;
        }

        return new Promise((resolve) => {
            this.queue.push(() => {
                this.current++;
                this.executionStack.push({contextId, depth: 1});
                resolve();
            });
        });
    }

    release(): void {
        if (this.executionStack.length === 0) {
            throw new Error("release() called without acquire()");
        }

        const lastContext = this.executionStack[this.executionStack.length - 1];
        lastContext.depth--;

        if (lastContext.depth === 0) {
            this.executionStack.pop();
            this.current--;

            if (this.queue.length > 0) {
                const next = this.queue.shift();
                if (next) next();
            }
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