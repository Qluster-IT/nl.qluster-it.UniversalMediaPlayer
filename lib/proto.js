'use strict';

class Defer {
    constructor(timeout, timeoutMessage = 'Operation timed out') {
        this.isSettled = false;
        this.promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });

        if (timeout !== undefined) {
            this.timer = setTimeout(() => {
                this.reject(new Error(timeoutMessage));
            }, timeout);
        }
    }

    then(onFulfilled, onRejected) {
        return this.promise.then(onFulfilled, onRejected);
    }

    catch(onRejected) {
        return this.promise.catch(onRejected);
    }

    finally(onFinally) {
        return this.promise.finally(onFinally);
    }

    resolve(...values) {
        if (this.isSettled) return;
        this.isSettled = true;
        clearTimeout(this.timer);
        this._resolve(...values);
    }

    reject(error) {
        if (this.isSettled) return;
        this.isSettled = true;
        clearTimeout(this.timer);
        this._reject(error);
    }
}

module.exports = { Defer };
