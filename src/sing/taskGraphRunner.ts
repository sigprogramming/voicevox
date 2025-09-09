import { createLogger } from "@/helpers/log";
import { getOrThrow } from "@/helpers/mapHelper";
import { ExhaustiveError } from "@/type/utility";

const logger = createLogger("sing/taskGraphRunner");

export type TaskRunStatus =
  | "AwaitingDependencies"
  | "Runnable"
  | "Running"
  | "Success"
  | "Failed"
  | "Skipped";

export type TaskCacheStatus = "Unchecked" | "Cached" | "NotCached";

export type TaskStatus = {
  runStatus: TaskRunStatus;
  cacheStatus: TaskCacheStatus;
};

export type SkipCondition =
  | "AnyDependencyFailedOrSkipped"
  | "AllDependenciesFailedOrSkipped";

export type TaskResultInfo =
  | { type: "Success" }
  | { type: "Failed"; error: unknown };

export interface Task<in TContext> {
  readonly dependencies: readonly Task<TContext>[];
  readonly skipCondition: SkipCondition;
  run(context: TContext): Promise<void>;
}

export interface NonCacheableTask<TContext> extends Task<TContext> {
  readonly isCacheable: false;
}

export interface CacheableTask<TContext> extends Task<TContext> {
  readonly isCacheable: true;

  isCached(context: TContext): Promise<boolean>;
}

export class TaskGraph<TContext, TTask extends Task<TContext>> {
  readonly tasks: readonly TTask[];
  readonly childrenMap: ReadonlyMap<TTask, readonly TTask[]>;
  readonly parentsMap: ReadonlyMap<TTask, readonly TTask[]>;

  constructor(tasks: readonly TTask[]) {
    const concreteTaskMap = new Map<Task<TContext>, TTask>();
    for (const task of tasks) {
      concreteTaskMap.set(task, task);
    }

    if (concreteTaskMap.size !== tasks.length) {
      throw new Error("Duplicate tasks are not allowed.");
    }
    for (const task of tasks) {
      for (const dependency of task.dependencies) {
        if (!concreteTaskMap.has(dependency)) {
          throw new Error("A dependency is not included in the task list.");
        }
      }
    }

    const parentsMap = new Map<TTask, TTask[]>();
    for (const task of tasks) {
      const concreteDependencies = task.dependencies.map((dependency) => {
        return getOrThrow(concreteTaskMap, dependency);
      });
      parentsMap.set(task, concreteDependencies);
    }

    const childrenMap = new Map<TTask, TTask[]>();
    for (const task of tasks) {
      childrenMap.set(task, []);
    }
    for (const task of tasks) {
      const parents = getOrThrow(parentsMap, task);
      for (const parent of parents) {
        const children = getOrThrow(childrenMap, parent);
        children.push(task);
      }
    }

    this.tasks = [...tasks];
    this.childrenMap = childrenMap;
    this.parentsMap = parentsMap;
  }
}

export type StartedEvent = {
  type: "started";
};

export type TaskStartedEvent<TContext, TTask extends Task<TContext>> = {
  type: "taskStarted";
  task: TTask;
  isCachedTask: boolean;
};

export type TaskFinishedEvent<TContext, TTask extends Task<TContext>> = {
  type: "taskFinished";
  task: TTask;
  isCachedTask: boolean;
  result: TaskResultInfo;
};

export type CompletedEvent = {
  type: "completed";
};

export type InterruptedEvent = {
  type: "interrupted";
};

export type TaskGraphRunnerEvent<TContext, TTask extends Task<TContext>> =
  | StartedEvent
  | TaskStartedEvent<TContext, TTask>
  | TaskFinishedEvent<TContext, TTask>
  | CompletedEvent
  | InterruptedEvent;

export type NextTaskToRunSelector<TContext, TTask extends Task<TContext>> = (
  tasks: readonly TTask[],
  taskStatusMap: ReadonlyMap<TTask, TaskStatus>,
  context: TContext,
) => Promise<TTask | undefined>;

export class TaskGraphRunner<
  TContext,
  TTask extends NonCacheableTask<TContext> | CacheableTask<TContext>,
> {
  private readonly context: TContext;
  private readonly taskGraph: TaskGraph<TContext, TTask>;
  private readonly selectNextTaskToRun: NextTaskToRunSelector<TContext, TTask>;
  private readonly prioritizeCachedTask: boolean;

  private readonly _taskStatuses: Map<TTask, TaskStatus>;
  private readonly runnableTasksPendingCacheCheck: TTask[];
  private readonly listeners: Set<
    (event: TaskGraphRunnerEvent<TContext, TTask>) => void
  > = new Set();

  private isStarted = false;
  private isRunning = false;
  private interruptionRequested = false;

  get taskStatuses(): ReadonlyMap<TTask, TaskStatus> {
    return this._taskStatuses;
  }

  constructor(
    context: TContext,
    taskGraph: TaskGraph<TContext, TTask>,
    nextTaskToRunSelector: NextTaskToRunSelector<TContext, TTask>,
    prioritizeCachedTask: boolean,
  ) {
    const taskStatuses: Map<TTask, TaskStatus> = new Map();
    const runnableTasksPendingCacheCheck: TTask[] = [];
    for (const task of taskGraph.tasks) {
      if (task.dependencies.length === 0) {
        taskStatuses.set(task, {
          runStatus: "Runnable",
          cacheStatus: "Unchecked",
        });
        runnableTasksPendingCacheCheck.push(task);
      } else {
        taskStatuses.set(task, {
          runStatus: "AwaitingDependencies",
          cacheStatus: "Unchecked",
        });
      }
    }

    this.context = context;
    this.taskGraph = taskGraph;
    this.selectNextTaskToRun = nextTaskToRunSelector;
    this.prioritizeCachedTask = prioritizeCachedTask;
    this._taskStatuses = taskStatuses;
    this.runnableTasksPendingCacheCheck = runnableTasksPendingCacheCheck;
  }

  async run() {
    if (this.isStarted) {
      throw new Error("TaskRunner has already been started.");
    }
    this.isStarted = true;
    this.isRunning = true;

    this.dispatchEvent({ type: "started" });

    const runnableCachedTasks: TTask[] = [];
    let interrupted = false;

    try {
      while (true) {
        if (this.interruptionRequested) {
          interrupted = true;
          break;
        }

        while (true) {
          const task = this.runnableTasksPendingCacheCheck.pop();
          if (task == undefined) {
            break;
          }

          const taskStatus = getOrThrow(this._taskStatuses, task);
          if (task.isCacheable) {
            const isCached = await task.isCached(this.context);
            if (isCached) {
              taskStatus.cacheStatus = "Cached";
              runnableCachedTasks.push(task);
            } else {
              taskStatus.cacheStatus = "NotCached";
            }
          }
        }

        let task: TTask | undefined = undefined;
        if (this.prioritizeCachedTask) {
          task = runnableCachedTasks.pop();
        }
        if (task == undefined) {
          task = await this.selectNextTaskToRun(
            this.taskGraph.tasks,
            this._taskStatuses,
            this.context,
          );
        }
        if (task == undefined) {
          break;
        }

        const taskStatus = this._taskStatuses.get(task);
        if (taskStatus == undefined) {
          throw new Error("Task is not in the task list.");
        }
        if (taskStatus.runStatus !== "Runnable") {
          throw new Error("Task is not runnable.");
        }
        const isCachedTask = taskStatus.cacheStatus === "Cached";

        taskStatus.runStatus = "Running";
        this.dispatchEvent({ type: "taskStarted", task, isCachedTask });

        let result: TaskResultInfo;
        try {
          await task.run(this.context);

          result = { type: "Success" };
        } catch (error) {
          result = { type: "Failed", error };
        }

        switch (result.type) {
          case "Success":
            taskStatus.runStatus = "Success";
            this.updateDescendantStatusesOnSuccess(task);
            break;
          case "Failed":
            taskStatus.runStatus = "Failed";
            this.updateDescendantStatusesOnFailure(task);
            break;
          default:
            throw new ExhaustiveError(result);
        }
        this.dispatchEvent({
          type: "taskFinished",
          task,
          isCachedTask,
          result,
        });
      }
    } finally {
      for (const task of this.taskGraph.tasks) {
        const status = getOrThrow(this._taskStatuses, task);
        if (
          status.runStatus === "AwaitingDependencies" ||
          status.runStatus === "Runnable"
        ) {
          status.runStatus = "Skipped";
        }
      }

      this.isRunning = false;
      this.interruptionRequested = false;

      if (interrupted) {
        this.dispatchEvent({ type: "interrupted" });
      } else {
        this.dispatchEvent({ type: "completed" });
      }
    }
  }

  requestInterruption() {
    if (!this.isRunning) {
      throw new Error("TaskRunner is not currently running.");
    }
    this.interruptionRequested = true;
  }

  addEventListener(
    listener: (event: TaskGraphRunnerEvent<TContext, TTask>) => void,
  ) {
    const exists = this.listeners.has(listener);
    if (exists) {
      throw new Error("Listener already exists.");
    }
    this.listeners.add(listener);
  }

  removeEventListener(
    listener: (event: TaskGraphRunnerEvent<TContext, TTask>) => void,
  ) {
    const exists = this.listeners.has(listener);
    if (!exists) {
      throw new Error("Listener does not exist.");
    }
    this.listeners.delete(listener);
  }

  private updateDescendantStatusesOnSuccess(successTask: TTask) {
    const childrenMap = this.taskGraph.childrenMap;
    const parentsMap = this.taskGraph.parentsMap;

    const isSettled = (task: TTask) => {
      const status = getOrThrow(this._taskStatuses, task);
      return (
        status.runStatus === "Success" ||
        status.runStatus === "Failed" ||
        status.runStatus === "Skipped"
      );
    };

    const children = getOrThrow(childrenMap, successTask);
    for (const child of children) {
      const childStatus = getOrThrow(this._taskStatuses, child);
      if (childStatus.runStatus !== "AwaitingDependencies") {
        continue;
      }

      const dependencies = getOrThrow(parentsMap, child);
      if (dependencies.every(isSettled)) {
        childStatus.runStatus = "Runnable";
        this.runnableTasksPendingCacheCheck.push(child);
      }
    }
  }

  private updateDescendantStatusesOnFailure(failedTask: TTask) {
    const childrenMap = this.taskGraph.childrenMap;
    const parentsMap = this.taskGraph.parentsMap;

    const isFailedOrSkipped = (task: TTask) => {
      const status = getOrThrow(this._taskStatuses, task);
      return status.runStatus === "Failed" || status.runStatus === "Skipped";
    };

    const isSettled = (task: TTask) => {
      const status = getOrThrow(this._taskStatuses, task);
      return (
        status.runStatus === "Success" ||
        status.runStatus === "Failed" ||
        status.runStatus === "Skipped"
      );
    };

    const stack = [failedTask];

    while (true) {
      const current = stack.pop();
      if (current == undefined) {
        break;
      }

      const children = getOrThrow(childrenMap, current);
      for (const child of children) {
        const childStatus = getOrThrow(this._taskStatuses, child);
        if (childStatus.runStatus !== "AwaitingDependencies") {
          continue;
        }

        const dependencies = getOrThrow(parentsMap, child);
        switch (child.skipCondition) {
          case "AnyDependencyFailedOrSkipped":
            if (dependencies.some(isFailedOrSkipped)) {
              childStatus.runStatus = "Skipped";
              stack.push(child);
              continue;
            }
            break;

          case "AllDependenciesFailedOrSkipped":
            if (dependencies.every(isFailedOrSkipped)) {
              childStatus.runStatus = "Skipped";
              stack.push(child);
              continue;
            }
            break;

          default:
            throw new ExhaustiveError(child.skipCondition);
        }

        if (dependencies.every(isSettled)) {
          childStatus.runStatus = "Runnable";
          this.runnableTasksPendingCacheCheck.push(child);
        }
      }
    }
  }

  private dispatchEvent(event: TaskGraphRunnerEvent<TContext, TTask>) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error("Error in listener: ", error);
      }
    }
  }
}
