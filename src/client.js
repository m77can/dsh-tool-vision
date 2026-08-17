// dsh-tool-vision 浏览器半部：发送拦截 + 会话内缩略图。
// 逻辑逐行移植自 dsh-tool-describe-image 的 client/send-hook.ts + client/preview.ts，
// 仅把 /describe-image 前缀改为 /vision，并把 CSS module 换成内联 <style>。
window.__ModuleLoader__.load({
  id: "@m77can/dsh-tool-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const ATTACH_ENDPOINT = '/vision/attach'
    const ACCEPTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    const CLIENT_MAX_BYTES = 10 * 1024 * 1024
    const IMAGE_ALT = '图片'
    const HOOK_MARKER = '__dshToolVisionSendHooked'

    // ---- client/attach.ts ----
    function insertNoteIntoDraft(draft, note, caret) {
      if (note === '') return draft
      const at = caret === undefined ? draft.length : Math.min(Math.max(caret, 0), draft.length)
      const before = draft.slice(0, at)
      const after = draft.slice(at)
      const needBefore = before !== '' && !/\s$/.test(before)
      const needAfter = after !== '' && !/^\s/.test(after)
      return before + (needBefore ? ' ' : '') + note + (needAfter ? ' ' : '') + after
    }

    function readFileAsBase64(file) {
      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onerror = () => resolve({ ok: false, message: 'read-failed' })
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : ''
          const comma = result.indexOf(',')
          if (comma < 0) {
            resolve({ ok: false, message: 'read-failed' })
            return
          }
          resolve({ ok: true, base64: result.slice(comma + 1) })
        }
        reader.readAsDataURL(file)
      })
    }

    async function uploadImageForDescribe(base64, mediaType, name) {
      let response
      try {
        response = await fetch(ATTACH_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: base64, mediaType, ...(name === undefined ? {} : { name }) }),
        })
      } catch {
        return { ok: false, message: 'network-failed' }
      }
      let envelope
      try {
        envelope = await response.json()
      } catch {
        return { ok: false, message: 'bad-response' }
      }
      const record = envelope
      if (record === null || typeof record !== 'object') return { ok: false, message: 'bad-response' }
      if (record.ok === true && record.value !== null && typeof record.value === 'object') {
        const value = record.value
        if (typeof value.markdown === 'string' && value.markdown !== '') {
          const id = value.ref?.attachmentId ?? value.id
          return { ok: true, markdown: value.markdown, id: typeof id === 'string' ? id : undefined }
        }
        return { ok: false, message: 'bad-response' }
      }
      const message = record.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'server-failed' }
    }

    function admitPickedImage(file) {
      if (!ACCEPTED_IMAGE_MIME.includes(file.type)) return { ok: false, reason: 'type' }
      if (file.size > CLIENT_MAX_BYTES) return { ok: false, reason: 'size' }
      return { ok: true }
    }

    // ---- client/send-hook.ts ----
    function installSendHook(conversation, isEnabled) {
      if (conversation === null || typeof conversation !== 'object') return
      if (typeof conversation.sendSession !== 'function') return
      if (typeof conversation.draftImages !== 'function' || typeof conversation.releaseDraftImage !== 'function') return
      if (conversation[HOOK_MARKER] === true) return

      const original = conversation.sendSession
      conversation.sendSession = async (session, text, imageIds, mode) => {
        if (isEnabled !== undefined && !isEnabled()) {
          return original.call(conversation, session, text, imageIds, mode)
        }
        if (imageIds.length === 0) {
          return original.call(conversation, session, text, imageIds, mode)
        }
        const attachments = conversation.draftImages(imageIds)
        if (attachments.length !== imageIds.length) {
          return original.call(conversation, session, text, imageIds, mode)
        }
        const refs = []
        for (const attachment of attachments) {
          const read = await readFileAsBase64(attachment.file)
          if (!read.ok) break
          const upload = await uploadImageForDescribe(read.base64, attachment.file.type, attachment.file.name)
          if (!upload.ok) break
          const id = upload.id
          refs.push(id !== undefined
            ? '![图片](' + window.location.origin + '/vision/raw/' + encodeURIComponent(id).replace(/%3A/gi, ':') + ')'
            : upload.markdown)
        }
        if (refs.length !== attachments.length) {
          return original.call(conversation, session, text, imageIds, mode)
        }
        const fullText = [text.trim(), ...refs].filter((part) => part !== '').join('\n')
        const result = await session.prompt([{ type: 'text', text: fullText }], mode)
        if (!result.ok) {
          throw new Error('conversation.send failed: ' + (result.error?.code ?? 'unknown') + ': ' + (result.error?.message ?? ''))
        }
        for (const id of imageIds) conversation.releaseDraftImage(id)
      }
      conversation[HOOK_MARKER] = true
    }

    // ---- client/preview.ts（内联样式版） ----
    const REFERENCE_PATTERN = /!\[([^\]]*)]\((?:https?:\/\/[^)\s]*)?(\/vision\/raw\/[^)\s]+)\)/g
    const CONVERSATION_ROOT_SELECTOR = '[data-slot="conversation.session"]'
    const PREVIEW_ATTR = 'data-dsh-vision-preview'
    const LIGHTBOX_ATTR = 'data-dsh-vision-lightbox'
    const MAX_FAILED_PATHS = 200

    function injectPreviewStyles() {
      if (document.querySelector('style[data-dsh-vision-styles]')) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-vision-styles', '')
      style.textContent = [
        '[data-dsh-vision-preview]{display:block;margin:6px 0}',
        '[data-dsh-vision-preview] button{all:unset;cursor:zoom-in;display:block;max-width:100%}',
        '[data-dsh-vision-preview] img{max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));display:block}',
        '[data-dsh-vision-lightbox]{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;cursor:zoom-out}',
        '[data-dsh-vision-lightbox] img{max-width:92vw;max-height:92vh;border-radius:12px}',
      ].join('')
      document.head.append(style)
    }

    function findImageReferences(text) {
      const matches = []
      REFERENCE_PATTERN.lastIndex = 0
      for (let match = REFERENCE_PATTERN.exec(text); match !== null; match = REFERENCE_PATTERN.exec(text)) {
        matches.push({ alt: match[1] ?? '', path: match[2] ?? '', start: match.index, end: match.index + match[0].length })
      }
      return matches
    }

    function installConversationImagePreview(isEnabled, root) {
      injectPreviewStyles()
      const failedPaths = new Set()
      let lightboxCleanup = undefined
      let contentObserver = undefined
      let mountObserver = undefined
      let observedRoot = undefined
      let disposed = false
      let scheduled = false

      const isExcluded = (node) => {
        const parent = node.parentElement
        if (parent === null) return true
        return parent.closest('input, textarea, script, style, [contenteditable], [' + PREVIEW_ATTR + ']') !== null
      }

      const rememberFailure = (path) => {
        if (failedPaths.size >= MAX_FAILED_PATHS) {
          const oldest = failedPaths.values().next()
          if (oldest.done !== true) failedPaths.delete(oldest.value)
        }
        failedPaths.add(path)
      }

      const restorePreview = (preview) => {
        const source = preview.getAttribute(PREVIEW_ATTR)
        if (source === null) return
        preview.replaceWith(document.createTextNode(source))
      }

      const scope = () => root ?? observedRoot

      const restoreAll = () => {
        const within = scope()
        if (within === undefined) return
        for (const preview of within.querySelectorAll('[' + PREVIEW_ATTR + ']')) restorePreview(preview)
      }

      const closeLightbox = () => {
        lightboxCleanup?.()
        lightboxCleanup = undefined
      }

      const openLightbox = (src, alt, trigger) => {
        closeLightbox()
        const overlay = document.createElement('div')
        overlay.setAttribute(LIGHTBOX_ATTR, '')
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.tabIndex = -1
        const image = document.createElement('img')
        image.src = src
        image.alt = alt
        overlay.append(image)
        overlay.addEventListener('click', closeLightbox)
        const onKeydown = (event) => {
          if (event.key === 'Escape') closeLightbox()
        }
        overlay.addEventListener('keydown', onKeydown)
        lightboxCleanup = () => {
          overlay.remove()
          if (trigger.isConnected) trigger.focus({ preventScroll: true })
        }
        document.body.append(overlay)
        overlay.focus()
      }

      const buildPreview = (match, source) => {
        const preview = document.createElement('span')
        preview.setAttribute(PREVIEW_ATTR, source)
        const button = document.createElement('button')
        button.type = 'button'
        button.title = '查看大图'
        button.setAttribute('aria-label', '查看大图')
        const image = document.createElement('img')
        image.src = window.location.origin + match.path
        image.alt = match.alt
        image.addEventListener('error', () => {
          rememberFailure(match.path)
          restorePreview(preview)
        }, { once: true })
        button.addEventListener('click', () => openLightbox(image.src, match.alt, button))
        button.append(image)
        preview.append(button)
        return preview
      }

      const enhanceNode = (node) => {
        const matches = findImageReferences(node.data).filter((match) => !failedPaths.has(match.path))
        if (matches.length === 0) return
        const text = node.data
        const fragment = document.createDocumentFragment()
        let cursor = 0
        for (const match of matches) {
          fragment.append(document.createTextNode(text.slice(cursor, match.start)))
          fragment.append(buildPreview(match, text.slice(match.start, match.end)))
          cursor = match.end
        }
        fragment.append(document.createTextNode(text.slice(cursor)))
        node.replaceWith(fragment)
      }

      const scanNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node
          if (text.data.includes('/vision/raw/') && !isExcluded(text)) enhanceNode(text)
          return
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: (candidate) => {
            const text = candidate
            if (!text.data.includes('/vision/raw/')) return NodeFilter.FILTER_REJECT
            return isExcluded(text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
          },
        })
        const targets = []
        while (walker.nextNode()) targets.push(walker.currentNode)
        for (const target of targets) enhanceNode(target)
      }

      const enhanceAll = () => {
        const within = scope()
        if (within !== undefined) scanNode(within)
      }

      const onContentRecords = (records) => {
        if (disposed || !isEnabled()) return
        for (const record of records) {
          if (record.type === 'characterData') scanNode(record.target)
          else for (const node of record.addedNodes) scanNode(node)
        }
      }

      const attach = () => {
        const next = root ?? document.querySelector(CONVERSATION_ROOT_SELECTOR) ?? undefined
        if (next === observedRoot) return
        contentObserver?.disconnect()
        observedRoot = next
        if (observedRoot !== undefined) {
          contentObserver = new MutationObserver(onContentRecords)
          contentObserver.observe(observedRoot, { childList: true, subtree: true, characterData: true })
          if (isEnabled()) enhanceAll()
        }
      }

      const schedule = () => {
        if (scheduled || disposed) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          if (!disposed) attach()
        })
      }

      const apply = () => {
        if (disposed) return
        if (isEnabled()) {
          attach()
          enhanceAll()
        } else {
          restoreAll()
        }
      }

      if (root === undefined) {
        mountObserver = new MutationObserver(schedule)
        mountObserver.observe(document.body, { childList: true, subtree: true })
      }
      attach()

      return {
        refresh: apply,
        dispose: () => {
          disposed = true
          mountObserver?.disconnect()
          contentObserver?.disconnect()
          restoreAll()
          closeLightbox()
        },
      }
    }

    function apply(ctx) {
      ctx.inject(['conversation'], (scope) => {
        try {
          installSendHook(scope.conversation)
        } catch (error) {
          console.error('[dsh-tool-vision] send hook failed:', error)
        }
        ctx.effect(() => {
          let preview = undefined
          try {
            preview = installConversationImagePreview(() => true)
          } catch (error) {
            console.error('[dsh-tool-vision] preview failed:', error)
          }
          return () => {
            try {
              preview?.dispose()
            } catch {
              // ignore
            }
          }
        }, 'tool-vision-client: preview')
      })
    }

    exports.name = 'tool-vision-client'
    exports.inject = ['conversation']
    exports.apply = apply
    return module.exports
  }
});
