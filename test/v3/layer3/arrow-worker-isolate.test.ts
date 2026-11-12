import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

describe('Arrow source in a worker isolate', () => {
  it('does not close a main-thread Session when the worker env exits', () => {
    const workerCode = `
      const {parentPort,workerData}=require('node:worker_threads');
      const m=require('./index.js');
      (async()=>{const s=new m.Session(workerData.path);
        try{await s.queryAsync('SELECT 1',{format:'CSV'})}
        finally{s.close();await m.drainPending()}
        parentPort.postMessage('ok');
      })().catch(e=>{parentPort.postMessage(e.message);process.exitCode=1});
    `
    const script = `
      const {Worker}=require('node:worker_threads'),m=require('./index.js');
      (async()=>{const s=new m.Session();
        try{const worker=new Worker(${JSON.stringify(workerCode)},{eval:true,workerData:{path:s.path}});
          const value=await new Promise((resolve,reject)=>{
            worker.once('message',resolve);worker.once('error',reject)
          });
          if(value!=='ok')throw Error(value);
          await new Promise((resolve,reject)=>worker.once('exit',code=>code===0?resolve():reject(Error('exit '+code))));
          const result=await s.queryAsync('SELECT 7',{format:'CSV'});
          if(result.text().trim()!=='7')throw Error('main Session was closed');
          console.log('concurrent isolate OK');
        }finally{s.close();await m.drainPending()}
      })().catch(e=>{console.error(e);process.exitCode=1});
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('concurrent isolate OK')
  })

  it('refuses a second isolate while a borrowed Arrow registration is live', () => {
    const script = `
      const {Worker}=require('node:worker_threads'),m=require('./index.js'),a=require('apache-arrow');
      (async()=>{const s=new m.Session();
        const b=new a.Table({x:a.vectorFromArray([1],new a.Int32())});
        const h=m.registerArrowSource(b,{session:s});
        try {
          const worker=new Worker("const m=require('./index.js'),{parentPort,workerData}=require('node:worker_threads');"+
            "try{new m.Session(workerData.path);parentPort.postMessage('unexpected success')}"+
            "catch(e){parentPort.postMessage(e.message)}",{eval:true,workerData:{path:s.path}});
          const message=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
          if(!/another Node isolate/.test(message))throw Error(message);
          await new Promise((resolve,reject)=>worker.once('exit',code=>code===0?resolve():reject(Error('exit '+code))));
          h.close();
          const reopened=new Worker("const m=require('./index.js'),{parentPort,workerData}=require('node:worker_threads');"+
            "try{const s=new m.Session(workerData.path);s.close();parentPort.postMessage('ok')}"+
            "catch(e){parentPort.postMessage(e.message)}",{eval:true,workerData:{path:s.path}});
          const ok=await new Promise((resolve,reject)=>{reopened.once('message',resolve);reopened.once('error',reject)});
          if(ok!=='ok')throw Error(ok);
          await new Promise((resolve,reject)=>reopened.once('exit',code=>code===0?resolve():reject(Error('exit '+code))));
        } finally {h.close();s.close();await m.drainPending()}
        console.log('isolated');
      })().catch(e=>{console.error(e);process.exitCode=1});
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('isolated')
  })

  it('refuses a borrowed source while another isolate holds a Session', () => {
    const script = `
      const {Worker}=require('node:worker_threads'),m=require('./index.js'),a=require('apache-arrow');
      (async()=>{const s=new m.Session();
        const worker=new Worker("const m=require('./index.js'),{parentPort,workerData}=require('node:worker_threads');"+
          "const s=new m.Session(workerData.path);parentPort.postMessage('open');"+
          "parentPort.once('message',()=>{s.close();parentPort.postMessage('closed')})",
          {eval:true,workerData:{path:s.path}});
        try {
          const opened=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
          if(opened!=='open')throw Error(opened);
          const b=new a.Table({x:a.vectorFromArray([1],new a.Int32())});
          try {m.registerArrowSource(b,{session:s});throw Error('unexpected source registration')}
          catch(e){if(!/another Node isolate/.test(e.message))throw e}
          worker.postMessage('close');
          const closed=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
          if(closed!=='closed')throw Error(closed);
          await new Promise((resolve,reject)=>worker.once('exit',code=>code===0?resolve():reject(Error('exit '+code))));
          const source=m.registerArrowSource(b,{session:s});source.close();
        } finally {s.close();await m.drainPending()}
        console.log('ownership enforced');
      })().catch(e=>{console.error(e);process.exitCode=1});
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('ownership enforced')
  })

  it('tears down reader references before another isolate opens a Session', () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      const m = require('./index.js');
      const worker = new Worker(\
        "const m=require('./index.js'),a=require('apache-arrow'),{parentPort}=require('node:worker_threads');"+
        "(async()=>{const s=new m.Session();const b=new a.Table({x:a.vectorFromArray([1],new a.Int32())}).batches[0];"+
        "const h=await m.registerArrowReader([b],{session:s});try{await s.queryAsync(\\\"SELECT x FROM arrowstream('\\\"+h.name+\\\"')\\\",{format:'CSV'})}"+
        "finally{await h.close();s.close();await m.drainPending()}parentPort.postMessage('ok')})().catch(e=>{parentPort.postMessage(e.message);process.exitCode=1})",
        {eval:true});
      worker.once('message', value => { if (value !== 'ok') throw Error(value); });
      worker.once('exit', async code => {
        if (code !== 0) throw Error('worker exited ' + code);
        const s = new m.Session();
        try { if (s.query('SELECT 7','CSV').trim() !== '7') throw Error('main query failed'); }
        finally { s.close(); }
        console.log('isolate OK');
      });
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('isolate OK')
  })
})
