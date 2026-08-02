/**
 * TransitionEngine — 状态迁移引擎。
 *
 * 职责单一：执行状态转换，失败时执行补偿。
 * 不关心业务规则，不关心「为什么转换」。
 *
 * 合法转换：
 *   cached → saved  (save)
 *   saved  → cached (unsave)
 *
 * 不合法转换（会返回错误）：
 *   cached → cached (幂等检查在调用方)
 *   saved  → saved  (幂等检查在调用方)
 *   → deleted      (不存在 deleted 状态)
 */
// 无额外导入 — PixivEntity 仅用于 JSDoc 类型标注

/**
 * Saga 日志 — 记录已执行的步骤，失败时用于补偿。
 * 不是 ACID 事务，只有「记录已做什么 → 失败时倒序回滚」。
 */
class Saga {
  constructor(name) {
    this.name = name;
    this.steps = [];
    this.logs = [];
    this.snapshot = null;
  }

  log(step, message) {
    this.steps.push(step);
    this.logs.push({ step, message, time: Date.now() });
  }

  hasCompleted(step) {
    return this.steps.includes(step);
  }
}

export class TransitionEngine {
  /**
   * @param {import('./repository.js').PixivRepository} repository
   * @param {import('./fileStore.js').FileStore} fileStore
   */
  constructor(repository, fileStore) {
    this.repository = repository;
    this.fileStore = fileStore;
  }

  /**
   * 执行状态迁移。
   *
   * @param {'cached→saved'|'saved→cached'} transition
   * @param {PixivEntity} entity
   * @returns {Promise<{success: boolean, entity?: PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async transition(transition, entity) {
    const [fromState, toState] = transition.split('→');

    // 幂等：已是目标状态
    if (entity.state === toState) {
      return { success: true, entity, idempotent: true };
    }

    // 状态校验：当前状态必须与转换起始状态一致
    if (entity.state !== fromState) {
      return {
        success: false,
        error: `invalid_state: expected ${fromState}, got ${entity.state}`,
      };
    }

    // 执行 Saga 补偿流程
    return await this._executeSaga(entity, fromState, toState);
  }

  /**
   * Saga 补偿流程。
   *
   * 三步策略：
   *   1. 准备 — 复制文件到目标目录
   *   2. 提交 — 更新元数据状态
   *   3. 清理 — 删除源文件
   *
   * 任何一步失败 → 倒序回滚已完成的步骤。
   */
  async _executeSaga(entity, fromState, toState) {
    const saga = new Saga(`transition:${fromState}→${toState}`);
    saga.snapshot = {
      entityId: entity.id,
      fromState,
      toState,
      oldState: entity.state,
    };

    try {
      // Step 1: 准备 — 复制文件到目标目录
      saga.log('copy_file', `复制文件: ${fromState} → ${toState}`);
      const copied = await this.fileStore.copy(entity, fromState, toState);
      if (!copied) {
        throw new Error('file_copy_failed');
      }

      // Step 2: 提交 — 更新元数据状态
      saga.log('update_meta', `更新状态: ${entity.id} → ${toState}`);
      await this.repository.changeState(entity.id, toState);

      // Step 3: 清理 — 删除源文件（非关键）
      saga.log('cleanup', `删除源文件: ${fromState}`);
      await this.fileStore.delete(entity, fromState).catch(() => {
        // 删除源文件失败不影响主流程
        // 只是多一个副本，下次清理时会处理
      });

      // 返回新状态的 entity
      return {
        success: true,
        entity: entity.withState(toState),
      };
    } catch (e) {
      // 补偿
      await this._compensate(saga, entity);
      return { success: false, error: e.message };
    }
  }

  /**
   * 补偿 — 倒序回滚已完成的步骤。
   */
  async _compensate(saga, entity) {
    const { fromState, toState } = saga.snapshot;

    // 倒序检查已完成的步骤
    const steps = [...saga.steps].reverse();

    for (const step of steps) {
      try {
        if (step === 'update_meta') {
          // 已更新元数据 → 恢复到旧状态
          await this.repository.changeState(entity.id, fromState);
        } else if (step === 'copy_file') {
          // 已复制文件到目标 → 删除目标文件
          await this.fileStore.delete(entity, toState);
        }
        // cleanup 步骤失败不需要补偿（源文件还在）
      } catch (compErr) {
        console.error('[TransitionEngine] 补偿失败:', step, compErr.message);
      }
    }
  }
}