
// 令牌桶速率限制器
// 用于限制点云数据的 HTTP 请求频率
class RateLimiter {

	constructor(refillRate = 100, maxTokens = 100) {
		this.refillRate = refillRate;
		this.maxTokens = maxTokens;
		this.tokens = maxTokens;
		this.lastRefillTime = performance.now();
	}

	_refill() {
		let now = performance.now();
		let elapsed = (now - this.lastRefillTime) / 1000;
		let newTokens = elapsed * this.refillRate;

		this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
		this.lastRefillTime = now;
	}

	tryAcquire() {
		// 关闭限速
		return true

		this._refill();

		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}

		return false;
	}

}

export const rateLimiter = new RateLimiter(10, 10);
