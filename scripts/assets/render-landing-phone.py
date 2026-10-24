"""Render the landing-page device in Blender 4.x; transparent RGBA, live HTML screen overlay.
Run: Blender --background --python scripts/assets/render-landing-phone.py -- /absolute/output/directory
"""
import bpy, math, sys
from pathlib import Path
from mathutils import Vector
out=Path(sys.argv[sys.argv.index('--')+1]);out.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def material(name,color,metal=0,rough=.25):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=rough
 return m
metal=material('Polar white aluminum',(.82,.84,.86),.72,.2)
edge=material('Pearl silver chamfer',(.94,.95,.97),.9,.13)
black=material('Black ceramic glass',(.006,.007,.009),.12,.14)
screen=material('Luminous pearl screen',(.99,.985,.98),0,.28)
bs=screen.node_tree.nodes.get('Principled BSDF');bs.inputs['Emission Color'].default_value=(.99,.985,.98,1);bs.inputs['Emission Strength'].default_value=3.2
def rounded(name,w,h,depth,radius,z,mat):
 vertices=[]
 for zz in [-depth/2+z,depth/2+z]:
  for cx,cy,angle in [(w/2-radius,h/2-radius,0),(-w/2+radius,h/2-radius,90),(-w/2+radius,-h/2+radius,180),(w/2-radius,-h/2+radius,270)]:
   for i in range(17):
    a=math.radians(angle+i*90/16);vertices.append((cx+radius*math.cos(a),cy+radius*math.sin(a),zz))
 n=len(vertices)//2
 faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update();mesh.use_auto_smooth=True
 obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(mat)
 bevel=obj.modifiers.new('Precision edge radii','BEVEL');bevel.width=.03;bevel.segments=4
 obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
 return obj
rounded('Polar white unibody',6.92,15,.46,.82,0,metal)
rounded('Pearl front chamfer',6.90,14.98,.07,.81,.23,edge)
rounded('Uniform micro bezel',6.84,14.92,.045,.78,.285,black)
rounded('Edge to edge display',6.72,14.78,.025,.75,.33,screen)
# Broad photographic softboxes create continuous highlights along the machined edges.
def light(name,loc,power,size,color,shape='DISK',size_y=None):
 data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape=shape;data.size=size;data.color=color
 if size_y is not None:data.size_y=size_y
 obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj);obj.location=loc;obj.rotation_euler=(Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()
light('Large warm soft key',(-7,7,11),1250,9,(1,.91,.86))
light('Pearl blue edge',(6,2,6),1050,3.5,(.82,.9,1),'RECTANGLE',13)
light('Rose lavender bounce',(-5,-6,4),780,6,(1,.72,.84),'RECTANGLE',3)
light('Soft frontal fill',(0,-1,12),520,10,(1,.98,.95))
world=bpy.data.worlds.new('Ambient studio');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.38,.34,.38,1);world.node_tree.nodes['Background'].inputs[1].default_value=.52;bpy.context.scene.world=world
camdata=bpy.data.cameras.new('Product camera');cam=bpy.data.objects.new('Product camera',camdata);bpy.context.collection.objects.link(cam);cam.location=(0,0,30);cam.rotation_euler=(0,0,0);cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler();camdata.type='ORTHO';camdata.ortho_scale=17.2
scene=bpy.context.scene;scene.camera=cam;scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True
scene.render.resolution_x=860;scene.render.resolution_y=1720;scene.render.resolution_percentage=100;scene.render.film_transparent=True
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.filepath=str(out/'phone-titanium.png')
scene.view_settings.view_transform='AgX'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).with_name('phone-studio.blend')))
bpy.ops.render.render(write_still=True)
