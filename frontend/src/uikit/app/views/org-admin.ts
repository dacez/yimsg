import { ORG_CHILD_PERSON, ORG_CHILD_TAG } from '../../../constants';
import { displayUserName } from '../../../sdk';
import type { AppInstance } from '../app-instance';

/**
 * 通讯录管理弹层：单页模态内自持面包屑栈，管理部门增删改、成员归属、
 * 排序与管理员授权。所有写操作只调用 SDK，不做本地乐观更新——结构变化靠
 * org:updated 轻通知 + 重新拉取本节点数据（本弹层每次写操作后重新 render 自己）。
 * 权限完全由服务端 requireOrgManage 把关：调用方对当前节点没有管理权限时，
 * 写 action 抛 FORBIDDEN，这里统一用 toast 提示，不在前端预判权限。
 */
export async function openOrgAdmin(app: AppInstance, orgId: string, initialTagId: string): Promise<void> {
  let stack: string[] = [initialTagId || orgId];
  let requestId = 0;

  async function render(): Promise<void> {
    const reqId = ++requestId;
    const tagId = stack[stack.length - 1];
    const isRoot = tagId === orgId;

    let items: Awaited<ReturnType<typeof app.client.getTags>>['tags'];
    try {
      items = (await app.client.getTags({ orgId, tagId, limit: 200 })).tags;
    } catch (e) {
      app.showToast(app.t('orgAdmin.loadFailed') + (e as Error).message, 'error');
      app.closeModal();
      return;
    }
    if (reqId !== requestId) return;

    let admins: string[] = [];
    try {
      admins = await app.client.listOrgAdmins(orgId, tagId);
    } catch {
      // 无权限时 listOrgAdmins 返回 FORBIDDEN：管理员区块留空展示，不阻断其余只读信息。
      admins = [];
    }
    if (reqId !== requestId) return;

    const memberUids = items.filter(i => i.childType === ORG_CHILD_PERSON).map(i => i.childId);
    const childTagIds = items.filter(i => i.childType === ORG_CHILD_TAG).map(i => i.childId);
    const ancestorTagIds = stack.filter(id => id !== orgId);
    const userDisplayMap = app.client.getUserInfos([...new Set([...memberUids, ...admins])]);
    const tagDisplayMap = app.client.getTagInfos(orgId, [...new Set([...childTagIds, ...ancestorTagIds])]);
    const orgDisplayMap = app.client.getOrgInfos([orgId]);

    const crumbNameOf = (id: string): string => id === orgId
      ? (orgDisplayMap.get(id)?.name || app.t('contacts.orgLoading'))
      : (tagDisplayMap.get(id)?.name || id);
    const currentName = crumbNameOf(tagId);

    const crumbsHtml = stack
      .map((id, i) => `<button class="org-crumb${i === stack.length - 1 ? ' org-crumb-current' : ''}" data-crumb="${i}">${app.escapeHtml(crumbNameOf(id))}</button>`)
      .join('<span class="org-crumb-sep">/</span>');

    const rowsHtml = items.map((item, idx) => {
      if (item.childType === ORG_CHILD_TAG) {
        const name = tagDisplayMap.get(item.childId)?.name || item.childId;
        return `
          <div class="org-admin-row" data-idx="${idx}">
            <div class="avatar avatar-sm">${app.escapeHtml((name || '?')[0] || '?')}</div>
            <div class="org-admin-row-name">${app.escapeHtml(name)}</div>
            <button class="btn btn-sm btn-secondary" data-enter="${idx}">${app.t('orgAdmin.enterBtn')}</button>
            <button class="btn btn-sm btn-secondary" data-rename-tag="${idx}">${app.t('orgAdmin.renameBtn')}</button>
            <button class="btn btn-sm btn-danger" data-delete-tag="${idx}">${app.t('orgAdmin.deleteTagBtn')}</button>
          </div>`;
      }
      const ud = userDisplayMap.get(item.childId);
      const name = displayUserName(ud || { nickname: '', avatarUrl: '', remarkName: '', username: '' }, item.childId);
      const titleHtml = item.title ? `<span class="org-member-title">${app.escapeHtml(item.title)}</span>` : '';
      return `
        <div class="org-admin-row" data-idx="${idx}">
          <div class="avatar avatar-sm">${app.escapeHtml(name[0] || '?')}</div>
          <div class="org-admin-row-name">${app.escapeHtml(name)} ${titleHtml}</div>
          <button class="btn btn-sm btn-secondary" data-rank-member="${idx}">${app.t('orgAdmin.setRankBtn')}</button>
          <button class="btn btn-sm btn-danger" data-remove-member="${idx}">${app.t('orgAdmin.removeMemberBtn')}</button>
        </div>`;
    }).join('') || `<div class="contacts-detail-empty">${app.escapeHtml(app.t('orgAdmin.empty'))}</div>`;

    const adminsHtml = admins.map((uid) => {
      const ud = userDisplayMap.get(uid);
      const name = displayUserName(ud || { nickname: '', avatarUrl: '', remarkName: '', username: '' }, uid);
      return `
        <div class="org-admin-row" data-uid="${uid}">
          <div class="avatar avatar-sm">${app.escapeHtml(name[0] || '?')}</div>
          <div class="org-admin-row-name">${app.escapeHtml(name)}</div>
          <button class="btn btn-sm btn-danger" data-revoke="${uid}">${app.t('orgAdmin.revokeBtn')}</button>
        </div>`;
    }).join('') || `<div class="contacts-detail-empty">${app.escapeHtml(app.t('orgAdmin.empty'))}</div>`;

    const modal = app.$('modal-content');
    modal.classList.add('modal-content-wide');
    modal.innerHTML = `
      <div class="modal-title">${app.escapeHtml(app.t('orgAdmin.title'))}</div>
      <div class="org-crumbs">${crumbsHtml}</div>
      <div class="org-admin-header">
        <strong>${app.escapeHtml(currentName)}</strong>
        <button class="btn btn-sm btn-secondary" id="oa-rename">${app.t('orgAdmin.renameBtn')}</button>
        ${isRoot ? `<button class="btn btn-sm btn-danger" id="oa-delete-org">${app.t('orgAdmin.deleteOrgBtn')}</button>` : ''}
      </div>
      <div class="org-admin-section">
        <div class="org-admin-section-title">
          ${app.escapeHtml(app.t('orgAdmin.subDeptTitle'))} / ${app.escapeHtml(app.t('orgAdmin.membersTitle'))}
          <button class="btn btn-sm btn-secondary" id="oa-create-tag">${app.t('orgAdmin.createTagBtn')}</button>
        </div>
        <div class="org-items">${rowsHtml}</div>
        <div class="form-group org-admin-inline-form">
          <label>${app.escapeHtml(app.t('orgAdmin.addMemberBtn'))}</label>
          <div class="org-admin-inline-row">
            <input class="input" type="text" id="oa-add-member-uid" placeholder="${app.escapeHtml(app.t('orgAdmin.addMemberUidPlaceholder'))}">
            <input class="input" type="text" id="oa-add-member-title" placeholder="${app.escapeHtml(app.t('orgAdmin.addMemberTitlePlaceholder'))}">
            <button class="btn btn-sm btn-primary" id="oa-add-member-submit">${app.t('orgAdmin.addMemberBtn')}</button>
          </div>
        </div>
      </div>
      <div class="org-admin-section">
        <div class="org-admin-section-title">${app.escapeHtml(app.t('orgAdmin.adminsTitle'))}</div>
        <div class="org-items">${adminsHtml}</div>
        <div class="form-group org-admin-inline-form">
          <div class="org-admin-inline-row">
            <input class="input" type="text" id="oa-grant-uid" placeholder="${app.escapeHtml(app.t('orgAdmin.grantUidPlaceholder'))}">
            <button class="btn btn-sm btn-primary" id="oa-grant-submit">${app.t('orgAdmin.grantBtn')}</button>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="oa-close">${app.t('orgAdmin.closeBtn')}</button>
      </div>
    `;
    app.$('modal-overlay').classList.remove('hidden');

    // ---- 导航：面包屑回退 / 进入子部门 ----
    modal.querySelectorAll<HTMLElement>('[data-crumb]').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.crumb);
        if (i < stack.length - 1) { stack = stack.slice(0, i + 1); void render(); }
      });
    });
    modal.querySelectorAll<HTMLElement>('[data-enter]').forEach((el) => {
      el.addEventListener('click', () => {
        const item = items[Number(el.dataset.enter)];
        stack = [...stack, item.childId];
        void render();
      });
    });

    // ---- 当前节点：重命名 ----
    app.$('oa-rename').addEventListener('click', async () => {
      const value = await app.showTextInputModal({
        title: app.t('orgAdmin.renameBtn'),
        initialValue: currentName,
        confirmText: app.t('orgAdmin.saveBtn'),
        cancelText: app.t('orgAdmin.cancelBtn'),
      });
      if (value) {
        try {
          if (isRoot) await app.client.renameOrg(orgId, value);
          else await app.client.renameOrgTag(orgId, tagId, value);
          app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
        } catch (e) {
          app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
        }
      }
      void render();
    });

    // ---- 组织根：删除整个组织（不可撤销，删后直接关闭弹层） ----
    if (isRoot) {
      app.$('oa-delete-org').addEventListener('click', async () => {
        const ok = await app.showConfirmModal({
          title: app.t('orgAdmin.deleteOrgConfirmTitle'),
          desc: app.t('orgAdmin.deleteOrgConfirmDesc'),
          confirmText: app.t('orgAdmin.confirmBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
          danger: true,
        });
        if (!ok) return;
        try {
          await app.client.deleteOrg(orgId);
          app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
        } catch (e) {
          app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          void render();
          return;
        }
        modal.classList.remove('modal-content-wide');
        app.closeModal();
      });
    }

    // ---- 子部门：新建 / 进入已在上面处理 / 改名 / 删除 ----
    app.$('oa-create-tag').addEventListener('click', async () => {
      const name = await app.showTextInputModal({
        title: app.t('orgAdmin.createTagPromptTitle'),
        label: app.t('orgAdmin.createTagPromptLabel'),
        confirmText: app.t('orgAdmin.createBtn'),
        cancelText: app.t('orgAdmin.cancelBtn'),
      });
      if (name) {
        try {
          await app.client.createOrgTag(orgId, tagId, name);
          app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
        } catch (e) {
          app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
        }
      }
      void render();
    });
    modal.querySelectorAll<HTMLElement>('[data-rename-tag]').forEach((el) => {
      el.addEventListener('click', async () => {
        const item = items[Number(el.dataset.renameTag)];
        const oldName = tagDisplayMap.get(item.childId)?.name || '';
        const name = await app.showTextInputModal({
          title: app.t('orgAdmin.renameBtn'),
          initialValue: oldName,
          confirmText: app.t('orgAdmin.saveBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
        });
        if (name) {
          try {
            await app.client.renameOrgTag(orgId, item.childId, name);
            app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
          } catch (e) {
            app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          }
        }
        void render();
      });
    });
    modal.querySelectorAll<HTMLElement>('[data-delete-tag]').forEach((el) => {
      el.addEventListener('click', async () => {
        const item = items[Number(el.dataset.deleteTag)];
        const ok = await app.showConfirmModal({
          title: app.t('orgAdmin.deleteTagConfirmTitle'),
          desc: app.t('orgAdmin.deleteTagConfirmDesc'),
          confirmText: app.t('orgAdmin.confirmBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
          danger: true,
        });
        if (ok) {
          try {
            await app.client.deleteOrgTag(orgId, item.childId);
            app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
          } catch (e) {
            app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          }
        }
        void render();
      });
    });

    // ---- 成员：添加 / 排序 / 移除 ----
    app.$('oa-add-member-submit').addEventListener('click', async () => {
      const uid = (app.$('oa-add-member-uid') as HTMLInputElement).value.trim();
      const title = (app.$('oa-add-member-title') as HTMLInputElement).value.trim();
      if (!uid) return;
      try {
        await app.client.addOrgMember(orgId, tagId, uid, { title });
        app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
      } catch (e) {
        app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
      }
      void render();
    });
    modal.querySelectorAll<HTMLElement>('[data-rank-member]').forEach((el) => {
      el.addEventListener('click', async () => {
        const item = items[Number(el.dataset.rankMember)];
        const value = await app.showTextInputModal({
          title: app.t('orgAdmin.setRankPromptTitle'),
          label: app.t('orgAdmin.setRankPromptLabel'),
          initialValue: String(item.rank),
          confirmText: app.t('orgAdmin.saveBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
        });
        if (value && !Number.isNaN(Number(value))) {
          try {
            await app.client.setOrgItemRank(orgId, tagId, item.childId, item.childType, Number(value), item.title);
            app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
          } catch (e) {
            app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          }
        }
        void render();
      });
    });
    modal.querySelectorAll<HTMLElement>('[data-remove-member]').forEach((el) => {
      el.addEventListener('click', async () => {
        const item = items[Number(el.dataset.removeMember)];
        const ok = await app.showConfirmModal({
          title: app.t('orgAdmin.removeMemberConfirmTitle'),
          confirmText: app.t('orgAdmin.confirmBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
          danger: true,
        });
        if (ok) {
          try {
            await app.client.removeOrgMember(orgId, tagId, item.childId);
            app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
          } catch (e) {
            app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          }
        }
        void render();
      });
    });

    // ---- 管理员：授予 / 撤销 ----
    app.$('oa-grant-submit').addEventListener('click', async () => {
      const uid = (app.$('oa-grant-uid') as HTMLInputElement).value.trim();
      if (!uid) return;
      try {
        await app.client.grantOrgAdmin(orgId, tagId, uid);
        app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
      } catch (e) {
        app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
      }
      void render();
    });
    modal.querySelectorAll<HTMLElement>('[data-revoke]').forEach((el) => {
      el.addEventListener('click', async () => {
        const uid = el.dataset.revoke!;
        const ok = await app.showConfirmModal({
          title: app.t('orgAdmin.revokeConfirmTitle'),
          confirmText: app.t('orgAdmin.confirmBtn'),
          cancelText: app.t('orgAdmin.cancelBtn'),
          danger: true,
        });
        if (ok) {
          try {
            await app.client.revokeOrgAdmin(orgId, tagId, uid);
            app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
          } catch (e) {
            app.showToast(app.t('orgAdmin.actionFailed') + (e as Error).message, 'error');
          }
        }
        void render();
      });
    });

    app.$('oa-close').addEventListener('click', () => {
      modal.classList.remove('modal-content-wide');
      app.closeModal();
    });
  }

  await render();
}
