import json,struct,glob,os,math,sys
from PIL import Image
base=sys.argv[1] if len(sys.argv)>1 else '/home/claude/vendor/hex/addons/kaykit_medieval_hexagon_pack/Assets/gltf/tiles'
tex=Image.open(base.split('/Assets/')[0]+'/Textures/hexagons_medieval.png').convert('RGB')
CT={5126:('f',4),5123:('H',2),5125:('I',4),5121:('B',1)}
NC={'SCALAR':1,'VEC2':2,'VEC3':3}
def acc(j,buf,i):
    a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
    fmt,sz=CT[a['componentType']]; n=NC[a['type']]; off=bv.get('byteOffset',0)+a.get('byteOffset',0); st=bv.get('byteStride',sz*n)
    return [struct.unpack_from('<'+fmt*n,buf,off+k*st) for k in range(a['count'])]
def cls(c):
    r,g,b=c
    if b>r+30 and b>g: return 'W'
    if g>r+15 and g>b: return 'G'   # green
    if r>150 and g>150 and b<110 and abs(r-g)<40: return 'G' # yellow-green grass
    if r>g>b: return 'R'
    return '?'
res={}
for p in sorted(glob.glob(base+'/**/*.gltf',recursive=True)):
    n=os.path.basename(p)[:-5]
    if not any(k in n for k in ('river','road','coast')): continue
    if 'waterless' in n: continue
    j=json.load(open(p)); buf=open(os.path.join(os.path.dirname(p),j['buffers'][0]['uri']),'rb').read()
    pts=[]
    for m in j['meshes']:
        for pr in m['primitives']:
            P=acc(j,buf,pr['attributes']['POSITION']); U=acc(j,buf,pr['attributes']['TEXCOORD_0']); I=[x[0] for x in acc(j,buf,pr['indices'])]
            for t in range(0,len(I),3):
                tri=[P[I[t+k]] for k in range(3)]; uv=[U[I[t+k]] for k in range(3)]
                cy=sum(v[1] for v in tri)/3
                if cy<-0.45: continue
                # normal up?
                a=[tri[1][i]-tri[0][i] for i in range(3)]; b=[tri[2][i]-tri[0][i] for i in range(3)]
                ny=a[2]*b[0]-a[0]*b[2]
                if abs(ny)<1e-4: continue
                cx=sum(v[0] for v in tri)/3; cz=sum(v[2] for v in tri)/3
                u=sum(x[0] for x in uv)/3; v=sum(x[1] for x in uv)/3
                col=tex.getpixel((min(1023,max(0,int(u*1024))),min(1023,max(0,int(v*1024)))))
                pts.append((cx,cz,cy,cls(col)))
    edges=''
    for e in range(6):
        ang=math.radians(e*60); mx,mz=0.9*math.cos(ang),0.9*math.sin(ang)
        near=[q for q in pts if (q[0]-mx)**2+(q[1]-mz)**2<0.09]
        if not near: edges+='.'; continue
        from collections import Counter
        c=Counter(q[3] for q in near); low=min(q[2] for q in near)
        k=c.most_common(1)[0][0]
        if 'W' in c and c['W']>=1: k='W'
        elif 'R' in c and c['R']>=1 and 'road' in n: k='R'
        edges+=k
    res[n]=edges
    print(f'{n:28s} {edges}')
json.dump(res,open('tools/edges.json','w'), indent=1)
