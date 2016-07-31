const Evernote = require('evernote').Evernote
const fs = require('fs')
const path = require('path')
const forge = require('node-forge')

const AUTH = process.env.LOLEN_AUTH
const NS_URL = process.env.LOLEN_NS_URL

if (!AUTH || !NS_URL) {
  console.error('please set LOLEN_AUTH and LOLEN_NS_URL environment variables')
  process.exit(1)
}

const LOLEN_NOTEBOOK_NAME = 'lolen'

const client = new Evernote.Client({
  token: AUTH
})

const userStore = client.getUserStore()
const noteStore = client.getNoteStore(NS_URL)

// FIXME: Factor out into an RPC module.
const getNotebookByName = (notebooks, name) => {
  if (!notebooks || !name) {
    throw new Error('bad params')
  }

  return notebooks.find(n => n.name.toUpperCase() === name.toUpperCase())
}

const createNotebook = notebook => {
  console.log('RPC: createNotebook')
  return new Promise((resolve, reject) => {
    noteStore.createNotebook(notebook, (err, createdNotebook) => {
      if (err) {
        reject(err)
      } else {
        resolve(createdNotebook)
      }
    })
  })
}

const createNote = note => {
  console.log('RPC: createNote')
  return new Promise((resolve, reject) => {
    noteStore.createNote(note, (err, createdNote) => {
      if (err) {
        reject(err)
      } else {
        resolve(createdNote)
      }
    })
  })
}

const updateNote = note => {
  console.log('RPC: updateNote')
  return new Promise((resolve, reject) => {
    noteStore.updateNote(note, (err, updatedNote) => {
      if (err) {
        reject(err)
      } else {
        resolve(updatedNote)
      }
    })
  })
}

const listNotebooks = () => {
  console.log('RPC: listNotebooks')
  return new Promise((resolve, reject) => {
    noteStore.listNotebooks((err, notebooks) => {
      if (err) {
        reject(err)
      } else {
        resolve(notebooks)
      }
    })
  })
}

const getFilteredSyncChunk = (afterUsn, maxEntries, filter) => {
  console.log('RPC: getFilteredSyncChunk')
  return new Promise((resolve, reject) => {
    noteStore.getFilteredSyncChunk(afterUsn, maxEntries, filter, (err, syncChunk) => {
      if (err) {
        reject(err)
      } else {
        resolve(syncChunk)
      }
    })
  })
}

const getAllNotesInNotebook = notebookGuid => {
  const fetchSyncChunk = afterUsn => {
    const filter = new Evernote.SyncChunkFilter()
    filter.includeNotes = true
    filter.includeNoteResources = true
    return getFilteredSyncChunk(afterUsn, 250, filter).then(syncChunk => {
      if (!syncChunk.notes) {
        return []
      } else {
        // We only create notes with a single resource.
        const notes = syncChunk.notes
            .filter(n => n.active && n.notebookGuid === notebookGuid && n.resources && n.resources.length === 1)
        return fetchSyncChunk(syncChunk.chunkHighUSN).then(nextNotes => {
          return [...notes, ...nextNotes]
        })
      }
    })
  }

  return fetchSyncChunk(0)
}

const getFilePaths = basePath => {
  const paths = []
  fs.readdirSync(basePath).forEach(f => {
    if (f === '.git') {
      return
    }

    f = path.join(basePath, f)
    if (fs.lstatSync(f).isDirectory()) {
      paths.push(...getFilePaths(f))
    } else {
      paths.push(f)
    }
  })
  return paths
}

const dataStringToMd5HashHex = data => {
  const md = forge.md.md5.create()
  md.update(data)
  return md.digest().toHex()
}

const bufferToString = buf => {
  buf = new Uint8Array(buf)
  const arr = []
  for (let b of buf) {
    arr.push(String.fromCharCode(b))
  }
  return arr.join('')
}

const isNewResourceDifferent = (newNote, oldNote) => {
  const newHashHex = dataStringToMd5HashHex(bufferToString(newNote.resources[0].data.body))
  const oldHashHex = forge.util.bytesToHex(oldNote.resources[0].data.bodyHash)
  return newHashHex !== oldHashHex
}

const extToMimes = new Map()
extToMimes.set('.pdf', 'application/pdf')
extToMimes.set('.png', 'image/png')
extToMimes.set('.bmp', 'image/bmp')
extToMimes.set('.gif', 'image/gif')
extToMimes.set('.jpg', 'image/jpeg')

const mimeFromFileName = fileName => {
  for (let [ext, mime] of extToMimes) {
    if (fileName.endsWith(ext)) {
      return mime
    }
  }

  return 'application/octet-stream'
}

const sanitizeEnmlChars = content => {
  const sb = []
  for (let c of content) {
    const cp = c.codePointAt(0)
    if (cp === 0x9 || cp === 0xa || cp === 0xd || cp >= 0x20 && cp <= 0xd7ff
        || cp >= 0xe000 && cp <= 0xfffd || cp >= 0x10000 && cp <= 0x10ffff) {
      sb.push(c)
    } else {
      console.log('illegal!', c)
    }
  }
  return sb.join('')
}

const printContentExts = /\.(txt|md|sh|js|java|xml|html)$/

const getPrintContent = (fileName, fileContentBuf) => {
  if (!fileName.match(printContentExts)) {
    return ''
  }

  return sanitizeEnmlChars(fileContentBuf.toString('utf8')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\n/g, '<br/>'))
}

const fileToNote = (fileName, fileContentBuf, notebookGuid) => {
  const note = new Evernote.Note()
  note.title = fileName
  note.notebookGuid = notebookGuid
  const resource = new Evernote.Resource()
  resource.data = new Evernote.Data()
  resource.data.body = fileContentBuf
  resource.mime = mimeFromFileName(fileName)
  resource.attributes = new Evernote.ResourceAttributes()
  resource.attributes.fileName = fileName
  note.resources = [resource]

  const contentHeader = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'
  const printContent = getPrintContent(fileName, fileContentBuf)
  const dataBodyHashHex = dataStringToMd5HashHex(bufferToString(resource.data.body))
  note.content = `${contentHeader}<en-note>${printContent}<en-media hash="${dataBodyHashHex}" type="${resource.mime}"/></en-note>`
  return note
}

// FIXME: Clean up the code below to make less terrible.
listNotebooks().then(notebooks => {
  const existingNotebook = getNotebookByName(notebooks, LOLEN_NOTEBOOK_NAME)
  if (existingNotebook) {
    return existingNotebook.guid
  } else {
    const newNotebook = new Evernote.Notebook()
    newNotebook.name = LOLEN_NOTEBOOK_NAME
    return createNotebook(newNotebook).then(serviceNewNotebook => {
      return serviceNewNotebook.guid
    })
  }
}).then(notebookGuid => {
  return getAllNotesInNotebook(notebookGuid).then(notes => {
    const duplicateNotes = []

    const notesByName = new Map()
    notes.forEach(note => {
      if (notesByName.has(note.title)) {
        // Track duplicate notes to inform the user later.
        duplicateNotes.push(note)
      } else {
        notesByName.set(note.title, note)
      }
    })

    // Recursively called after each RPC.
    const slowlyUpdateNotes = pathStack => {
      if (!pathStack || !pathStack.length) {
        return
      }

      const fileName = pathStack.pop()
      const fileContent = fs.readFileSync(fileName)

      // Edge case: if the file is 0 bytes, then the SDK will fail to upload.
      if (!fileContent || !fileContent.length) {
        console.log('Skipping 0 byte file', fileName)
        slowlyUpdateNotes(pathStack)
        return
      }

      const note = fileToNote(fileName, fileContent, notebookGuid)

      if (notesByName.has(fileName)) {
        const existingNote = notesByName.get(fileName)

        if (isNewResourceDifferent(note, existingNote)) {
          // Update the note's resource (and content if applicable).
          note.guid = existingNote.guid
          note.resources[0].guid = existingNote.resources[0].guid
          updateNote(note).then(() => {
            console.log('Updated:', fileName)
            slowlyUpdateNotes(pathStack)
          }, err => console.log('error updating:', fileName, err))
        } else {
          // Skip - no change since last time.
          slowlyUpdateNotes(pathStack)
        }
      } else {
        // New note, or file was renamed - create.
        createNote(note).then(() => {
          console.log('Created:', fileName)
          slowlyUpdateNotes(pathStack)
        }, err => console.log('error updating:', note, note.resources[0], err))
      }
    }

    const filePaths = getFilePaths('.')
    console.log('creating or updating', filePaths.length, 'files...')
    slowlyUpdateNotes([...filePaths])

    // Tell the user about things that they should delete, but don't actually do it
    // because that's scary.
    console.log('Found', duplicateNotes.length, 'duplicate notes:')
    duplicateNotes.forEach(n => console.log(n.guid, '-', n.title))

    const fileSet = new Set(filePaths)
    const unseenNotes = [...notesByName.values()].filter(n => !fileSet.has(n.title))
    console.log('Found', unseenNotes.length, 'unseen notes:')
    unseenNotes.forEach(n => console.log(n.guid, '-', n.title))
  })
}).catch(err => {
  console.log('catch all err', err)
})
