// Runs one task at a time; onWait is told how many tasks are ahead whenever that changes
const createQueue = () => {
  const waiting = [];
  let isRunning = false;

  const notifyWaiting = () => {
    waiting.forEach((item, index) => item.onWait?.(index + (isRunning ? 1 : 0)));
  };

  const runNext = async () => {
    if (isRunning || waiting.length === 0) return;
    isRunning = true;
    const item = waiting.shift();
    notifyWaiting();
    try {
      item.resolve(await item.task());
    } catch (err) {
      item.reject(err);
    } finally {
      isRunning = false;
      runNext();
    }
  };

  return (task, onWait) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, onWait, resolve, reject });
      runNext();
      notifyWaiting();
    });
};

module.exports = { createQueue };
