#!/usr/bin/env python3
"""Fix ADMIN closeout hint cache key mismatch + EVAL generate toasts."""
from pathlib import Path

PANEL = Path(__file__).resolve().parents[2] / "codeflowmu-desktop" / "panel" / "index.html"
text = PANEL.read_text(encoding="utf-8")

# i18n keys
text = text.replace(
    "    'tdp.ac.generating':'正在生成…',\n    'tdp.ac.generateFail':'EVAL 生成失败',",
    "    'tdp.ac.generating':'正在生成…',\n    'tdp.ac.generatingEval':'正在生成 EVAL…',\n    'tdp.ac.generateOk':'EVAL 已生成',\n    'tdp.ac.generateFail':'EVAL 生成失败',\n    'tdp.ac.generateFailDetail':'生成失败：{err}',",
)
text = text.replace(
    "    'tdp.ac.generating':'Generating…',\n    'tdp.ac.generateFail':'Failed to generate EVAL',",
    "    'tdp.ac.generating':'Generating…',\n    'tdp.ac.generatingEval':'Generating EVAL…',\n    'tdp.ac.generateOk':'EVAL generated',\n    'tdp.ac.generateFail':'Failed to generate EVAL',\n    'tdp.ac.generateFailDetail':'Generation failed: {err}',",
)

old_apply = """function _applyAdminCloseoutResponse(tid,d){
  if(!tid)return;
  const hint=(d&&d.admin_closeout_hint)||_deriveAdminCloseoutHintFromCloseout(d&&d.closeout);
  if(hint)_adminCloseoutHintByTaskId[tid]=hint;
  if(d&&d.closeout)_tdpAdminCloseout=d.closeout;
}"""

new_apply = """function _adminCloseoutHintKeys(tid,filename){
  const keys=new Set();
  const add=k=>{if(k)keys.add(String(k));};
  add(tid);
  if(filename){
    const fn=String(filename);
    add(fn.replace(/\\.md$/i,''));
    add(taskIdPrefix(fn));
  }else{
    add(taskIdPrefix(String(tid||'')));
  }
  return keys;
}
function _applyAdminCloseoutResponse(tid,d,filename){
  if(!tid&&!filename)return;
  const hint=(d&&d.admin_closeout_hint)||_deriveAdminCloseoutHintFromCloseout(d&&d.closeout);
  if(hint){
    for(const k of _adminCloseoutHintKeys(tid,filename)){
      _adminCloseoutHintByTaskId[k]=hint;
    }
  }
  if(d&&d.closeout)_tdpAdminCloseout=d.closeout;
}"""

if old_apply not in text:
    raise SystemExit("_applyAdminCloseoutResponse block not found")
text = text.replace(old_apply, new_apply)

text = text.replace(
    "      if(d.ok)_applyAdminCloseoutResponse(fnKey,d);",
    "      if(d.ok)_applyAdminCloseoutResponse(tid,d,f.filename);",
)

old_tdp_gen = """function adminGenerateEvalInline(filename){
  const fn=filename||'';
  const tid=taskIdPrefix(fn);
  if(!tid){showToast(t('toast.taskFileUnknown'),'#fca5a5');return;}
  tdpGenerateAdminEval(tid,false);
}

function tdpGenerateAdminEval(taskId, forceRegenerate){
  const btn=document.getElementById('tdp-ac-generate-eval')||document.getElementById('tdp-ac-regenerate-eval');
  const btnLabel=forceRegenerate?t('tdp.ac.refreshEval'):t('tdp.ac.generateEval');
  if(btn){
    btn.disabled=true;
    btn.textContent=t('tdp.ac.generating');
  }
  fetch('/api/v2/admin/task-closeout/generate-eval',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({task_id:taskId, force_regenerate:!!forceRegenerate})
  })
    .then(r=>r.json())
    .then(d=>{
      if(d.error||!d.ok){
        alert(t('tdp.ac.generateFail'));
        if(btn){
          btn.disabled=false;
          btn.textContent=btnLabel;
        }
        return;
      }
      _applyAdminCloseoutResponse(taskId,{closeout:d.closeout,admin_closeout_hint:_deriveAdminCloseoutHintFromCloseout(d.closeout)});
      if(_tdpFile) renderAdminTaskCloseout(_tdpFile);
      renderList();
      if(_tdpFile&&taskIdPrefix(_tdpFile.filename||'')===taskId){
        updateTdpLifecycleButtons(_tdpFile);
        updateTdpLifecycleHint(_tdpFile,taskEffectiveScopeKey(_tdpFile),_panelOperatorRole());
      }
    })
    .catch(()=>{
      alert(t('tdp.ac.generateFail'));
      if(btn){
        btn.disabled=false;
        btn.textContent=btnLabel;
      }
    });
}"""

new_tdp_gen = """function adminGenerateEvalInline(filename){
  const fn=filename||'';
  const tid=taskIdPrefix(fn);
  if(!tid){showToast(t('toast.taskFileUnknown'),'#fca5a5');return;}
  tdpGenerateAdminEval(tid,false,fn);
}

function tdpGenerateAdminEval(taskId, forceRegenerate, filename){
  const btn=document.getElementById('tdp-ac-generate-eval')||document.getElementById('tdp-ac-regenerate-eval');
  const btnLabel=forceRegenerate?t('tdp.ac.refreshEval'):t('tdp.ac.generateEval');
  const fn=filename||(_tdpFile&&taskIdPrefix(_tdpFile.filename||'')===taskId?_tdpFile.filename:null);
  if(btn){
    btn.disabled=true;
    btn.textContent=t('tdp.ac.generating');
  }
  showToast(t('tdp.ac.generatingEval'),'#38bdf8');
  fetch('/api/v2/admin/task-closeout/generate-eval',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({task_id:taskId, force_regenerate:!!forceRegenerate})
  })
    .then(r=>r.json())
    .then(d=>{
      if(d.error||!d.ok){
        const errMsg=String(d.message||d.error||d.code||t('tdp.ac.generateFail'));
        showToast(t('tdp.ac.generateFailDetail',{err:errMsg}),'#fca5a5');
        if(btn){
          btn.disabled=false;
          btn.textContent=btnLabel;
        }
        return;
      }
      const hint=d.admin_closeout_hint||_deriveAdminCloseoutHintFromCloseout(d.closeout);
      const hasEval=!!(d.closeout&&d.closeout.eval_observation);
      if(!hasEval){
        const errMsg=String((d.result&&d.result.reason)||t('tdp.ac.generateFail'));
        showToast(t('tdp.ac.generateFailDetail',{err:errMsg}),'#fca5a5');
        if(btn){
          btn.disabled=false;
          btn.textContent=btnLabel;
        }
        return;
      }
      _applyAdminCloseoutResponse(taskId,{closeout:d.closeout,admin_closeout_hint:hint},fn);
      showToast(t('tdp.ac.generateOk'),'#4ade80');
      if(_tdpFile) renderAdminTaskCloseout(_tdpFile);
      renderList();
      if(_tdpFile&&taskIdPrefix(_tdpFile.filename||'')===taskId){
        updateTdpLifecycleButtons(_tdpFile);
        updateTdpLifecycleHint(_tdpFile,taskEffectiveScopeKey(_tdpFile),_panelOperatorRole());
      }
    })
    .catch(err=>{
      showToast(t('tdp.ac.generateFailDetail',{err:String(err&&err.message||err||'')}),'#fca5a5');
      if(btn){
        btn.disabled=false;
        btn.textContent=btnLabel;
      }
    });
}"""

if old_tdp_gen not in text:
    raise SystemExit("tdpGenerateAdminEval block not found")
text = text.replace(old_tdp_gen, new_tdp_gen)

text = text.replace(
    "      _applyAdminCloseoutResponse(fnKey,d);",
    "      _applyAdminCloseoutResponse(tid,d,fn);",
)

# Fix delete on load fail — clear all hint keys
text = text.replace(
    "        if(fnKey)delete _adminCloseoutHintByTaskId[fnKey];",
    "        for(const k of _adminCloseoutHintKeys(tid,fn))delete _adminCloseoutHintByTaskId[k];",
)
text = text.replace(
    "      if(tid)delete _adminCloseoutHintByTaskId[tid];",
    "      for(const k of _adminCloseoutHintKeys(tid,fn))delete _adminCloseoutHintByTaskId[k];",
)

PANEL.write_text(text, encoding="utf-8")
print("Patched", PANEL)
